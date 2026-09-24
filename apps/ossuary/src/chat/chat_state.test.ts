import { describe, expect, it } from "vitest";
import { apply_event } from "./apply_event";
import { apply_submit_result } from "./apply_submit_result";
import { error_text } from "./error_text";
import { parse_serve_event_params } from "./parse_event";
import { submit_notice_blocks } from "./submit_notices";
import { event_blocks } from "./event_blocks";
import { user_block } from "./transcript";
import { INITIAL_UI_STATE, type UiState } from "./types";

const usage = (total_tokens: number) => ({
  prompt_tokens: total_tokens,
  completion_tokens: total_tokens,
  total_tokens,
});

describe("apply_event", () => {
  it("mirrors TUI phase transitions for a tool turn", () => {
    let state: UiState = INITIAL_UI_STATE;
    const call = { id: "1", name: "shell", args: { cmd: "ls" } };
    state = apply_event(state, { type: "llm_start", turn: 1 });
    expect(state.phase).toBe("thinking");
    state = apply_event(state, {
      type: "llm_end",
      turn: 1,
      result: { usage: usage(40) },
    });
    expect(state.usage.total_tokens).toBe(40);
    state = apply_event(state, { type: "tool_call_start", turn: 1, call });
    expect(state.phase).toBe("tool");
    state = apply_event(state, {
      type: "tool_call_end",
      turn: 1,
      call,
      result: { ok: true, output: "ok" },
    });
    expect(state.phase).toBe("thinking");
    state = apply_event(state, { type: "turn_end", turn: 1 });
    expect(state.turns_used).toBe(1);
  });

  it("records wire-shaped error objects", () => {
    const errored = apply_event(INITIAL_UI_STATE, {
      type: "error",
      error: { message: "boom" },
    });
    expect(errored.last_error).toBe("boom");
  });

  it("falls back for empty wire error objects", () => {
    const errored = apply_event(INITIAL_UI_STATE, { type: "error", error: {} });
    expect(errored.last_error).toBe("unknown error");
  });
});

describe("apply_submit_result", () => {
  it("returns idle and marks aborted runs", () => {
    const thinking: UiState = { ...INITIAL_UI_STATE, phase: "thinking" };
    const done = apply_submit_result(thinking, {
      session_id: "s1",
      reply: "hi",
      usage: usage(10),
      session_path: "/tmp/s.jsonl",
      turns_used: 2,
      stopped_reason: "aborted",
    });
    expect(done.phase).toBe("idle");
    expect(done.turns_used).toBe(2);
    expect(done.session_path).toBe("/tmp/s.jsonl");
    expect(done.last_error).toBe("run aborted");
  });
});

describe("parse_serve_event_params", () => {
  it("accepts a tool_call_end notification payload", () => {
    const parsed = parse_serve_event_params({
      session_id: "abc",
      event: {
        type: "tool_call_end",
        turn: 1,
        call: { id: "1", name: "shell", args: {} },
        result: { ok: true, output: "x" },
      },
    });
    expect(parsed?.session_id).toBe("abc");
    expect(parsed?.event.type).toBe("tool_call_end");
  });

  it("rejects malformed payloads", () => {
    expect(parse_serve_event_params({ session_id: 1 })).toBeUndefined();
    expect(parse_serve_event_params({ session_id: "a", event: { type: "llm_start" } })).toBeUndefined();
  });
});

describe("transcript helpers", () => {
  it("builds user and submit notice blocks", () => {
    expect(user_block("hello").lines[0]).toContain("hello");
    expect(submit_notice_blocks({ reply: "yo", stopped_reason: "final" })[0]?.role).toBe("lich");
    expect(submit_notice_blocks({ reply: undefined, stopped_reason: "budget" })[0]?.role).toBe("error");
  });

  it("maps tool_call_end into a tool block", () => {
    const blocks = event_blocks({
      type: "tool_call_end",
      turn: 1,
      call: { id: "1", name: "shell", args: { cmd: "ls" } },
      result: { ok: true, output: "a" },
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.role).toBe("tool");
  });

  it("maps empty wire error objects to a notice without [object Object]", () => {
    const blocks = event_blocks({ type: "error", error: {} });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.role).toBe("error");
    expect(blocks[0]?.lines.join("\n")).toContain("unknown error");
    expect(blocks[0]?.lines.join("\n")).not.toContain("[object Object]");
  });
});

describe("error_text", () => {
  it("prefers message on wire-shaped objects and falls back for empty payloads", () => {
    expect(error_text({ message: "boom" })).toBe("boom");
    expect(error_text({})).toBe("unknown error");
    expect(error_text({ message: 12 })).toBe("unknown error");
    expect(error_text(new Error("live"))).toBe("live");
    expect(error_text("plain")).toBe("plain");
  });
});
