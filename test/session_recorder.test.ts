/**
 * Session recorder: synthetic AgentEvents → JSONL lines; crash = stop after k.
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentEventBody } from "../src/agent/events.js";
import { create_session_recorder } from "../src/session/recorder.js";
import { open_session, read_session_messages, type SessionRecord } from "../src/session/store.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const temp_dirs: string[] = [];

afterAll(async () => {
  for (const dir of temp_dirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function make_temp_dir(): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(path.join(TMP_BASE, "session-recorder-"));
  temp_dirs.push(dir);
  return dir;
}

async function read_records(file_path: string): Promise<SessionRecord[]> {
  const raw = await readFile(file_path, "utf8");
  const records: SessionRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    records.push(JSON.parse(line) as SessionRecord);
  }
  return records;
}

function llm_end(content: string): AgentEventBody {
  return {
    type: "llm_end",
    turn: 1,
    result: {
      message: { role: "assistant", content },
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      finish_reason: "stop",
      model: "mock",
      provider_name: "mock",
    },
  };
}

function tool_call_end(ok: boolean): AgentEventBody {
  return {
    type: "tool_call_end",
    turn: 1,
    call: { id: "c1", name: "read_file", args: { path: "a.txt" } },
    result: ok
      ? { ok: true, output: "file body" }
      : { ok: false, output: "", error: "missing" },
  };
}

describe("session recorder", () => {
  it("maps llm_end, tool_call_end, and budget_exhausted to JSONL lines", async () => {
    const dir = await make_temp_dir();
    const handle = await open_session(dir, "rec");
    const recorder = create_session_recorder(handle);
    await recorder.seed({
      input: "hi",
      history: [],
      system_prompt: "sys",
      owned: true,
    });
    recorder.on_event(llm_end("thinking"));
    recorder.on_event(tool_call_end(true));
    recorder.on_event(llm_end("done"));
    recorder.on_event({ type: "budget_exhausted", turns_used: 2 });
    await recorder.finish("budget", { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });

    const records = await read_records(handle.path);
    expect(records[0]?.meta).toMatchObject({ event: "run_start", input_chars: 2 });
    expect(records.some((record) => record.message?.role === "system")).toBe(true);
    expect(records.some((record) => record.message?.role === "user" && record.message.content === "hi")).toBe(
      true,
    );
    expect(records.filter((record) => record.message?.role === "assistant").map((r) => r.message?.content)).toEqual([
      "thinking",
      "done",
    ]);
    const tool = records.find((record) => record.message?.role === "tool");
    expect(tool?.message).toMatchObject({
      role: "tool",
      tool_call_id: "c1",
      name: "read_file",
      content: "file body",
    });
    expect(records.some((record) => record.meta?.event === "budget_exhausted")).toBe(true);
    expect(records.at(-1)?.meta).toEqual({
      event: "run_end",
      stopped_reason: "budget",
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    });
    const messages = await read_session_messages(handle.path);
    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  it("crash after k events keeps every message emitted so far", async () => {
    const dir = await make_temp_dir();
    const handle = await open_session(dir, "crash");
    const recorder = create_session_recorder(handle);
    await recorder.seed({
      input: "go",
      history: [],
      system_prompt: "sys",
      owned: true,
    });
    const events: AgentEventBody[] = [
      llm_end("one"),
      tool_call_end(false),
      llm_end("two"),
      { type: "compress_end", summary_chars: 12 },
      llm_end("three"),
    ];
    const crash_after = 3;
    for (const event of events.slice(0, crash_after)) {
      recorder.on_event(event);
    }
    await recorder.flush();

    const messages = await read_session_messages(handle.path);
    expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "assistant"]);
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: "two" });
    const records = await read_records(handle.path);
    expect(records.some((record) => record.meta?.event === "compress_end")).toBe(false);
    expect(records.some((record) => record.meta?.event === "run_end")).toBe(false);
  });

  it("does not append an assistant line for compression usage", async () => {
    const dir = await make_temp_dir();
    const handle = await open_session(dir, "compress-usage");
    const recorder = create_session_recorder(handle);
    await recorder.seed({
      input: "go",
      history: [],
      system_prompt: "sys",
      owned: true,
    });
    recorder.on_event(llm_end("real reply"));
    recorder.on_event({
      type: "compress_end",
      summary_chars: 20,
      usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
    });
    await recorder.flush();

    const messages = await read_session_messages(handle.path);
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: "real reply" });
    const records = await read_records(handle.path);
    expect(records.some((record) => record.meta?.event === "compress_end")).toBe(true);
    expect(
      records.some(
        (record) =>
          record.message?.role === "assistant" && record.message.content !== "real reply",
      ),
    ).toBe(false);
  });

  it("shared handle seeds history once across runs", async () => {
    const dir = await make_temp_dir();
    const handle = await open_session(dir, "shared");
    const first = create_session_recorder(handle);
    await first.seed({
      input: "a",
      history: [{ role: "user", content: "prior" }],
      system_prompt: "sys",
      owned: false,
    });
    first.on_event(llm_end("reply-a"));
    await first.finish("final", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });

    const second = create_session_recorder(handle);
    await second.seed({
      input: "b",
      history: [
        { role: "user", content: "prior" },
        { role: "user", content: "a" },
        { role: "assistant", content: "reply-a" },
      ],
      system_prompt: "sys",
      owned: false,
    });
    second.on_event(llm_end("reply-b"));
    await second.finish("final", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });

    const messages = await read_session_messages(handle.path);
    expect(messages.map((message) => `${message.role}:${"content" in message ? message.content : ""}`)).toEqual([
      "system:sys",
      "user:prior",
      "user:a",
      "assistant:reply-a",
      "user:b",
      "assistant:reply-b",
    ]);
  });
});
