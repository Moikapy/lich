/**
 * A-5 / A-6: per-run usage isolation and memoized MCP attach.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { create_agent } from "../src/agent/agent.js";
import { COMPRESSION_SYSTEM_PROMPT } from "../src/context/compressor.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const temp_dirs: string[] = [];

afterAll(async () => {
  for (const dir of temp_dirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function make_temp_dir(): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(path.join(TMP_BASE, "agent-usage-"));
  temp_dirs.push(dir);
  return dir;
}

function completion_body(tokens: number) {
  return {
    model: "mock-model",
    choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: tokens, completion_tokens: 0, total_tokens: tokens },
  };
}

describe("Agent.run concurrent usage (A-5)", () => {
  it("does not mix usage_total across overlapping runs on one Agent", async () => {
    const work_dir = await make_temp_dir();
    let call = 0;
    const fetch_fn: typeof fetch = async () => {
      call += 1;
      const tokens = call === 1 ? 2 : 4;
      // Stagger so both runs overlap on the shared emitter path.
      if (call === 1) {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return new Response(JSON.stringify(completion_body(tokens)), { status: 200 });
    };
    const agent = create_agent({
      providers: [
        {
          kind: "openai_compat",
          name: "mock",
          model: "mock-model",
          base_url: "http://mock.local/v1",
          fetch_fn,
        },
      ],
      work_dir,
      session_dir: path.join(work_dir, "sessions"),
    });
    const [a, b] = await Promise.all([agent.run({ input: "one" }), agent.run({ input: "two" })]);
    const totals = [a.usage_total.total_tokens, b.usage_total.total_tokens].sort((x, y) => x - y);
    expect(totals).toEqual([2, 4]);
  });
});

const CHAT_USAGE = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 };
const COMPRESS_USAGE = { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 };

function long_history(): Array<{ role: "user"; content: string }> {
  const pad = "x".repeat(400);
  return Array.from({ length: 12 }, (_unused, index) => ({
    role: "user" as const,
    content: `note ${index} ${pad}`,
  }));
}

function scripted_fetch(fail_compress: boolean): { fetch_fn: typeof fetch; counts: { compress: number; chat: number } } {
  const counts = { compress: 0, chat: 0 };
  const fetch_fn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string; content?: string }> };
    const system = body.messages?.find((message) => message.role === "system")?.content ?? "";
    const compressing = system.includes(COMPRESSION_SYSTEM_PROMPT.slice(0, 24));
    if (compressing === true) {
      counts.compress += 1;
      if (fail_compress === true) {
        return new Response("summarizer down", { status: 400 });
      }
      return new Response(JSON.stringify({
        model: "mock-model",
        choices: [{ message: { role: "assistant", content: "TERSE SUMMARY" }, finish_reason: "stop" }],
        usage: COMPRESS_USAGE,
      }), { status: 200 });
    }
    counts.chat += 1;
    return new Response(JSON.stringify({
      model: "mock-model",
      choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      usage: CHAT_USAGE,
    }), { status: 200 });
  };
  return { fetch_fn, counts };
}

describe("Agent.run compression usage", () => {
  it("adds summarizer tokens to usage_total", async () => {
    const work_dir = await make_temp_dir();
    const { fetch_fn, counts } = scripted_fetch(false);
    const agent = create_agent({
      providers: [{ kind: "openai_compat", name: "mock", model: "mock-model", base_url: "http://mock.local/v1", fetch_fn }],
      work_dir,
      session_dir: path.join(work_dir, "sessions"),
      context_budget_tokens: 100,
      compress_threshold: 0.8,
      max_turns: 2,
      log_level: "error",
    });
    const result = await agent.run({ input: "go", history: long_history() });
    expect(counts.compress).toBeGreaterThan(0);
    expect(counts.chat).toBe(1);
    expect(result.usage_total).toEqual({
      prompt_tokens: COMPRESS_USAGE.prompt_tokens * counts.compress + CHAT_USAGE.prompt_tokens,
      completion_tokens: COMPRESS_USAGE.completion_tokens * counts.compress + CHAT_USAGE.completion_tokens,
      total_tokens: COMPRESS_USAGE.total_tokens * counts.compress + CHAT_USAGE.total_tokens,
    });
    expect(result.messages.some((message) => message.role === "user" && message.content.includes("TERSE SUMMARY"))).toBe(true);
  });

  it("leaves usage_total at the chat call when compression fails before a usage payload", async () => {
    const work_dir = await make_temp_dir();
    const { fetch_fn, counts } = scripted_fetch(true);
    const agent = create_agent({
      providers: [{ kind: "openai_compat", name: "mock", model: "mock-model", base_url: "http://mock.local/v1", fetch_fn }],
      work_dir,
      session_dir: path.join(work_dir, "sessions"),
      context_budget_tokens: 100,
      compress_threshold: 0.8,
      max_turns: 2,
      log_level: "error",
    });
    const result = await agent.run({ input: "go", history: long_history() });
    expect(counts.compress).toBeGreaterThan(0);
    expect(counts.chat).toBe(1);
    expect(result.usage_total).toEqual(CHAT_USAGE);
    expect(result.outcome.stopped_reason).toBe("final");
    expect(result.messages.some((message) => message.content.includes("TERSE SUMMARY"))).toBe(false);
  });
});
