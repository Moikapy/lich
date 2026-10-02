/**
 * #149 PR A: `models.chat` / `models.compress` provider roles.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { create_agent } from "../src/agent/agent.js";
import { parse_agent_config } from "../src/agent/config.js";
import { run_conversation, type LoopDeps } from "../src/agent/loop.js";
import type { ChatFn } from "../src/context/compressor.js";
import { ProviderRouter } from "../src/providers/router.js";
import type { ChatResult, Message, ProviderConfig } from "../src/providers/types.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const temp_dirs: string[] = [];

afterAll(async () => {
  for (const dir of temp_dirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function make_temp_dir(): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(path.join(TMP_BASE, "model-roles-"));
  temp_dirs.push(dir);
  return dir;
}

const providers = [
  { kind: "openai_compat", name: "a", model: "m" },
  { kind: "openai_compat", name: "b", model: "m" },
  { kind: "ollama", name: "local", model: "m" },
];

function config_with(name: string, hits: string[], status = 200): ProviderConfig {
  const fetch_fn: typeof fetch = async () => {
    hits.push(name);
    const body = {
      model: "m",
      choices: [{ message: { role: "assistant", content: `from ${name}` }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    return new Response(JSON.stringify(body), { status });
  };
  return { kind: "openai_compat", name, model: "m", api_key: "k", base_url: "http://mock.local/v1", fetch_fn };
}

function result(content: string): ChatResult {
  return {
    message: { role: "assistant", content },
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    finish_reason: "stop",
    model: "mock-model",
    provider_name: "mock",
  };
}

function is_compress_call(messages: readonly Message[]): boolean {
  const first = messages[0];
  return first?.role === "system" && first.content.includes("compress");
}

describe("models config", () => {
  it("is optional and absent by default", () => {
    expect(parse_agent_config({ providers }).models).toBeUndefined();
  });

  it("accepts known provider names per role", () => {
    const config = parse_agent_config({ providers, models: { chat: ["b", "a"], compress: ["local"] } });
    expect(config.models).toEqual({ chat: ["b", "a"], compress: ["local"] });
    expect(Object.isFrozen(config.models)).toBe(true);
  });

  it("rejects unknown and repeated names, empty lists and unknown roles", () => {
    expect(() => parse_agent_config({ providers, models: { chat: ["nope"] } })).toThrow(/unknown provider .*nope/);
    expect(() => parse_agent_config({ providers, models: { compress: ["a", "a"] } })).toThrow(/listed twice/);
    expect(() => parse_agent_config({ providers, models: { chat: [] } })).toThrow();
    expect(() => parse_agent_config({ providers, models: { embed: ["a"] } })).toThrow();
  });
});

describe("ProviderRouter.for_role", () => {
  it("keeps the given order and shares built clients", () => {
    const router = new ProviderRouter(parse_agent_config({ providers }).providers);
    const role = router.for_role(["local", "a"]);
    expect(role.list().map((provider) => provider.name)).toEqual(["local", "a"]);
    expect(role.get("a")).toBe(router.get("a"));
  });

  it("throws on an unknown name", () => {
    const router = new ProviderRouter(parse_agent_config({ providers }).providers);
    expect(() => router.for_role(["zzz"])).toThrow(/unknown provider/);
  });

  it("fails over within the role only", async () => {
    const hits: string[] = [];
    const router = new ProviderRouter([config_with("a", hits), config_with("b", hits, 401), config_with("c", hits)]);
    const out = await router.for_role(["b", "c"]).chat_with_failover([{ role: "user", content: "hi" }], []);
    expect(out.message.content).toBe("from c");
    expect(hits).toEqual(["b", "c"]);
  });
});

describe("compress role in the loop", () => {
  const pad = "x".repeat(400);
  const seed: Message[] = Array.from({ length: 11 }, (_unused, index) => ({
    role: "user" as const,
    content: `note ${index} ${pad}`,
  }));
  const params = { max_turns: 1, context_budget_tokens: 100, compress_threshold: 0.8 };
  const runner: LoopDeps["tools"] = { execute: async () => ({ ok: true, output: "ok" }) };

  it("summarizes with compress_chat when set", async () => {
    const main_calls: string[] = [];
    const chat: ChatFn = async (messages) => {
      main_calls.push(is_compress_call(messages) ? "compress" : "turn");
      return result("done");
    };
    const compress_chat: ChatFn = async () => result("CHEAP SUMMARY");
    const outcome = await run_conversation({ chat, compress_chat, tools: runner, definitions: () => [] }, seed, params);
    expect(main_calls).toEqual(["turn"]);
    expect(outcome.messages.some((message) => message.content?.includes("CHEAP SUMMARY") === true)).toBe(true);
  });

  it("falls back to chat when compress_chat fails", async () => {
    const chat: ChatFn = async (messages) => result(is_compress_call(messages) ? "MAIN SUMMARY" : "done");
    const compress_chat: ChatFn = async () => {
      throw new Error("local model down");
    };
    const outcome = await run_conversation({ chat, compress_chat, tools: runner, definitions: () => [] }, seed, params);
    expect(outcome.messages.some((message) => message.content?.includes("MAIN SUMMARY") === true)).toBe(true);
  });
});

describe("Agent model roles", () => {
  it("routes the main loop through models.chat", async () => {
    const work_dir = await make_temp_dir();
    const hits: string[] = [];
    const agent = create_agent({
      providers: [config_with("a", hits), config_with("b", hits)],
      models: { chat: ["b"] },
      work_dir,
      session_dir: path.join(work_dir, "sessions"),
      log_level: "error",
    });
    const run = await agent.run({ input: "go" });
    expect(run.outcome.final?.content).toBe("from b");
    expect(hits).toEqual(["b"]);
  });

  it("keeps providers order without a models block", async () => {
    const work_dir = await make_temp_dir();
    const hits: string[] = [];
    const agent = create_agent({
      providers: [config_with("a", hits), config_with("b", hits)],
      work_dir,
      session_dir: path.join(work_dir, "sessions"),
      log_level: "error",
    });
    const run = await agent.run({ input: "go" });
    expect(run.outcome.final?.content).toBe("from a");
    expect(hits).toEqual(["a"]);
  });
});
