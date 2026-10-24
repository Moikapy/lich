/**
 * Session recorder: synthetic AgentEvents → JSONL lines; crash = stop after k.
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentEventBody } from "../src/agent/events.js";
import { create_session_recorder, mark_session_seeded } from "../src/session/recorder.js";
import { open_session, read_session_messages, type SessionHandle, type SessionRecord } from "../src/session/store.js";
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

function record_line(record: SessionRecord): string {
  if (record.message === undefined) {
    return `meta:${String(record.meta?.event)}`;
  }
  const content = "content" in record.message ? record.message.content : "";
  return `${record.message.role}:${content}`;
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

/** `with_call` adds the read_file call that `tool_call_end` answers, as a real run records it. */
function llm_end(content: string, with_call = false): AgentEventBody {
  const tool_calls = with_call === true ? [{ id: "c1", name: "read_file", args: { path: "a.txt" } }] : undefined;
  return {
    type: "llm_end",
    turn: 1,
    result: {
      message: tool_calls === undefined ? { role: "assistant", content } : { role: "assistant", content, tool_calls },
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
    recorder.on_event(llm_end("thinking", true));
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
      llm_end("one", true),
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

  it("does not prepend system_prompt when history already has a system message", async () => {
    const dir = await make_temp_dir();
    const handle = await open_session(dir, "has-system");
    const recorder = create_session_recorder(handle);
    await recorder.seed({
      input: "now",
      history: [
        { role: "system", content: "from-history" },
        { role: "user", content: "prior" },
      ],
      system_prompt: "fresh",
      owned: true,
    });
    await recorder.flush();
    const records = await read_records(handle.path);
    expect(records.map(record_line)).toEqual([
      "meta:run_start",
      "system:from-history",
      "user:prior",
      "user:now",
    ]);
  });

  it("still copies history for an owned seed after the handle is marked seeded", async () => {
    const dir = await make_temp_dir();
    const handle = await open_session(dir, "owned-mark");
    mark_session_seeded(handle);
    const owned = create_session_recorder(handle);
    await owned.seed({
      input: "a",
      history: [{ role: "user", content: "prior" }],
      system_prompt: "sys",
      owned: true,
    });
    await owned.finish("final", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });

    const shared = create_session_recorder(handle);
    await shared.seed({
      input: "b",
      history: [
        { role: "system", content: "sys" },
        { role: "user", content: "prior" },
        { role: "user", content: "a" },
      ],
      system_prompt: "sys",
      owned: false,
    });
    await shared.flush();

    const records = await read_records(handle.path);
    expect(records.map(record_line)).toEqual([
      "meta:run_start",
      "system:sys",
      "user:prior",
      "user:a",
      "meta:run_end",
      "meta:run_start",
      "user:b",
    ]);
  });

  it("keeps writing after an append fails and records a zero-length summary", async () => {
    const records: SessionRecord[] = [];
    let fail_remaining = 1;
    const handle: SessionHandle = {
      id: "fail",
      path: "virtual.jsonl",
      append: async (record) => {
        if (fail_remaining > 0) {
          fail_remaining -= 1;
          throw new Error("disk full");
        }
        records.push(record);
      },
    };
    const recorder = create_session_recorder(handle);
    await recorder.seed({
      input: "hi",
      history: [],
      system_prompt: "sys",
      owned: true,
    });
    expect(records.map((record) => record.message?.content)).toEqual(["sys", "hi"]);

    fail_remaining = 1;
    recorder.on_event(llm_end("one"));
    recorder.on_event(llm_end("two"));
    recorder.on_event({ type: "compress_end", summary_chars: 0 });
    await recorder.flush();
    expect(records.filter((record) => record.message?.role === "assistant").map((record) => record.message?.content)).toEqual([
      "two",
    ]);
    expect(records.some((record) => record.meta?.event === "compress_end" && record.meta.summary_chars === 0)).toBe(
      true,
    );
    expect(JSON.stringify(records)).not.toContain("disk full");
  });
});
