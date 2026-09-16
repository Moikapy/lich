/**
 * run_end meta: stopped_reason and usage land in the session JSONL.
 * Mock provider only. Sessions stay under test/.tmp.
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { create_agent } from "../src/agent/agent.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const temp_dirs: string[] = [];

afterAll(async () => {
  for (const dir of temp_dirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function make_temp_dir(): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(path.join(TMP_BASE, "session-persist-"));
  temp_dirs.push(dir);
  return dir;
}

function completion_body(message: Record<string, unknown>, finish_reason: string, usage: Record<string, number>) {
  return { model: "mock-model", choices: [{ message, finish_reason }], usage };
}

function scripted_fetch(body: unknown): typeof fetch {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

async function meta_records(file_path: string): Promise<Array<{ kind: string; meta?: Record<string, unknown> }>> {
  const raw = await readFile(file_path, "utf8");
  const records: Array<{ kind: string; meta?: Record<string, unknown> }> = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    records.push(JSON.parse(line) as { kind: string; meta?: Record<string, unknown> });
  }
  return records.filter((record) => record.kind === "meta");
}

describe("session run_end", () => {
  it("appends run_end with stopped_reason final and usage_total", async () => {
    const work_dir = await make_temp_dir();
    const usage = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 };
    const agent = create_agent({
      providers: [
        {
          kind: "openai_compat",
          name: "mock",
          model: "mock-model",
          base_url: "http://mock.local/v1",
          fetch_fn: scripted_fetch(completion_body({ role: "assistant", content: "ok" }, "stop", usage)),
        },
      ],
      work_dir,
      session_dir: path.join(work_dir, "sessions"),
      log_level: "error",
    });
    const result = await agent.run({ input: "hello" });
    expect(result.session_path).toBeDefined();
    const events = await meta_records(result.session_path ?? "");
    const run_end = events.find((record) => record.meta?.event === "run_end");
    expect(run_end?.meta).toEqual({ event: "run_end", stopped_reason: "final", usage: result.usage_total });
    expect(result.usage_total).toEqual(usage);
  });

  it("appends budget_exhausted and run_end when the turn budget stops the run", async () => {
    const work_dir = await make_temp_dir();
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    const tool_message = {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "t1", type: "function", function: { name: "missing_tool", arguments: "{}" } },
      ],
    };
    const agent = create_agent({
      providers: [
        {
          kind: "openai_compat",
          name: "mock",
          model: "mock-model",
          base_url: "http://mock.local/v1",
          fetch_fn: scripted_fetch(completion_body(tool_message, "tool_calls", usage)),
        },
      ],
      work_dir,
      session_dir: path.join(work_dir, "sessions"),
      max_turns: 1,
      log_level: "error",
    });
    const result = await agent.run({ input: "go" });
    expect(result.outcome.stopped_reason).toBe("budget");
    const events = await meta_records(result.session_path ?? "");
    expect(events.some((record) => record.meta?.event === "budget_exhausted")).toBe(true);
    const run_end = events.find((record) => record.meta?.event === "run_end");
    expect(run_end?.meta).toMatchObject({ event: "run_end", stopped_reason: "budget", usage: result.usage_total });
  });

  it("appends run_end when the run is aborted before a turn", async () => {
    const work_dir = await make_temp_dir();
    const fetch_fn: typeof fetch = () => Promise.reject(new Error("should not chat"));
    const agent = create_agent({
      providers: [{ kind: "openai_compat", name: "mock", model: "mock-model", base_url: "http://mock.local/v1", fetch_fn }],
      work_dir,
      session_dir: path.join(work_dir, "sessions"),
      log_level: "error",
    });
    const result = await agent.run({ input: "stop", signal: AbortSignal.abort() });
    expect(result.outcome.stopped_reason).toBe("aborted");
    const events = await meta_records(result.session_path ?? "");
    const run_end = events.find((record) => record.meta?.event === "run_end");
    expect(run_end?.meta).toEqual({
      event: "run_end",
      stopped_reason: "aborted",
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  });
});
