import { describe, expect, it, vi } from "vitest";
import { apply_event } from "./apply_event";
import { apply_submit_result } from "./apply_submit_result";
import { error_text } from "./error_text";
import { parse_serve_event_params } from "./parse_event";
import { parse_submit_result } from "./parse_submit_result";
import { parse_wire_event } from "./parse_wire_event";
import { create_prompt_submit_settle } from "./prompt_submit_settle";
import { submit_notice_blocks } from "./submit_notices";
import { event_blocks } from "./event_blocks";
import { cleared_chat_local_state } from "./chat_local_state";
import { user_block } from "./transcript";
import { INITIAL_UI_STATE, type HistoryBlock, type UiState } from "./types";

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

  it("records tool failure, keeps last_error on cancel, and folds budget and compression", () => {
    const failed = apply_event(INITIAL_UI_STATE, {
      type: "tool_call_end",
      turn: 1,
      call: { id: "1", name: "shell", args: {} },
      result: { ok: false, output: "", error: "denied" },
    });
    expect(failed.phase).toBe("thinking");
    expect(failed.last_error).toBe("denied");

    const bare = apply_event(INITIAL_UI_STATE, {
      type: "tool_call_end",
      turn: 1,
      call: { id: "1", name: "shell", args: {} },
      result: { ok: false, output: "" },
    });
    expect(bare.last_error).toBe("tool failed");

    const prior: UiState = { ...INITIAL_UI_STATE, last_error: "kept" };
    const cancelled = apply_event(prior, {
      type: "tool_call_end",
      turn: 1,
      call: { id: "1", name: "shell", args: {} },
      result: { ok: false, output: "" },
      cancelled: true,
    });
    expect(cancelled.last_error).toBe("kept");

    expect(apply_event(INITIAL_UI_STATE, { type: "budget_exhausted", turns_used: 8 }).budget_exhausted).toBe(
      true,
    );
    const started = apply_event(INITIAL_UI_STATE, { type: "compress_start", estimated_tokens: 100 });
    expect(started.compress_count).toBe(1);
    const skipped = apply_event(started, { type: "compress_end", summary_chars: 3 });
    expect(skipped.usage.total_tokens).toBe(0);
    const added = apply_event(skipped, {
      type: "compress_end",
      summary_chars: 3,
      usage: usage(5),
    });
    expect(added.usage.total_tokens).toBe(5);
    expect(added.compress_count).toBe(1);
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

  it("keeps the prior session path and error when the result omits them", () => {
    const prior: UiState = {
      ...INITIAL_UI_STATE,
      session_path: "/tmp/keep.jsonl",
      last_error: "old",
    };
    const done = apply_submit_result(prior, {
      session_id: "s1",
      reply: "hi",
      usage: usage(1),
      turns_used: 1,
      stopped_reason: "final",
    });
    expect(done.phase).toBe("idle");
    expect(done.session_path).toBe("/tmp/keep.jsonl");
    expect(done.last_error).toBe("old");
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

  it("drops cancelled tool rows and keeps a budget notice beside a partial reply", () => {
    expect(
      event_blocks({
        type: "tool_call_end",
        turn: 1,
        call: { id: "1", name: "shell", args: {} },
        result: { ok: false, output: "" },
        cancelled: true,
      }),
    ).toEqual([]);
    const blocks = submit_notice_blocks({ reply: "partial", stopped_reason: "budget" });
    expect(blocks.map((block) => block.role)).toEqual(["error", "lich"]);
    expect(blocks[0]?.lines.join("\n")).toContain("budget exhausted");
    const compressed = event_blocks({ type: "compress_end", summary_chars: 12 });
    expect(compressed[0]?.role).toBe("meta");
    expect(compressed[0]?.lines[0]).toContain("12");
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

describe("create_prompt_submit_settle", () => {
  const result = {
    session_id: "old",
    reply: "stale",
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    session_path: "/tmp/s.jsonl",
    turns_used: 1,
    stopped_reason: "final" as const,
  };

  it("leaves transcript and busy unchanged when session_ref no longer matches", () => {
    const session_ref = { current: "old" as string | undefined };
    const set_ui = vi.fn() as unknown as (value: never) => void;
    const set_blocks = vi.fn() as unknown as (value: never) => void;
    const set_busy = vi.fn() as unknown as (value: never) => void;
    const settle = create_prompt_submit_settle(
      "old",
      session_ref,
      set_ui as never,
      set_blocks as never,
      set_busy as never,
    );
    session_ref.current = undefined;
    settle.on_fulfilled(result);
    settle.on_rejected(new Error("late"));
    settle.on_settled();
    expect(set_ui).not.toHaveBeenCalled();
    expect(set_blocks).not.toHaveBeenCalled();
    expect(set_busy).not.toHaveBeenCalled();
  });

  it("applies result and clears busy when the submitted session is still active", () => {
    const session_ref = { current: "old" as string | undefined };
    const blocks: HistoryBlock[] = [];
    const set_ui = vi.fn((value: UiState | ((current: UiState) => UiState)) => {
      if (typeof value === "function") {
        value(INITIAL_UI_STATE);
      }
    });
    const set_blocks = vi.fn(
      (value: readonly HistoryBlock[] | ((current: readonly HistoryBlock[]) => readonly HistoryBlock[])) => {
        if (typeof value === "function") {
          blocks.splice(0, blocks.length, ...value(blocks));
        }
      },
    );
    const set_busy = vi.fn();
    const settle = create_prompt_submit_settle(
      "old",
      session_ref,
      set_ui,
      set_blocks,
      set_busy,
    );
    settle.on_fulfilled(result);
    settle.on_settled();
    expect(set_ui).toHaveBeenCalled();
    expect(set_blocks).toHaveBeenCalled();
    expect(blocks.some((block) => block.lines.some((line) => line.includes("stale")))).toBe(true);
    expect(set_busy).toHaveBeenCalledWith(false);
  });

  it("records the rejection and clears busy while the session is still active", () => {
    const session_ref = { current: "old" as string | undefined };
    let ui = INITIAL_UI_STATE;
    const blocks: HistoryBlock[] = [];
    const set_ui = vi.fn((value: UiState | ((current: UiState) => UiState)) => {
      ui = typeof value === "function" ? value(ui) : value;
    });
    const set_blocks = vi.fn(
      (value: readonly HistoryBlock[] | ((current: readonly HistoryBlock[]) => readonly HistoryBlock[])) => {
        blocks.splice(0, blocks.length, ...(typeof value === "function" ? value(blocks) : value));
      },
    );
    const set_busy = vi.fn();
    const settle = create_prompt_submit_settle("old", session_ref, set_ui, set_blocks, set_busy);
    settle.on_rejected(new Error("gateway not connected"));
    settle.on_settled();
    expect(ui.phase).toBe("idle");
    expect(blocks.some((block) => block.lines.some((line) => line.includes("gateway not connected")))).toBe(
      true,
    );
    expect(set_busy).toHaveBeenCalledWith(false);
  });
});

describe("cleared_chat_local_state", () => {
  it("returns empty blocks and idle busy for session changes", () => {
    expect(cleared_chat_local_state()).toEqual({ blocks: [], busy: false });
  });
});

const submit_payload = {
  session_id: "s1",
  reply: "hi",
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  session_path: "/tmp/s.jsonl",
  turns_used: 2,
  stopped_reason: "budget" as const,
};

describe("parse_wire_event", () => {
  it("rejects non-objects, unknown kinds, and events missing required fields", () => {
    expect(parse_wire_event(null)).toBeUndefined();
    expect(parse_wire_event([])).toBeUndefined();
    expect(parse_wire_event({ type: "nope" })).toBeUndefined();
    expect(parse_wire_event({ type: "llm_start", turn: "1" })).toBeUndefined();
    expect(parse_wire_event({ type: "llm_end", turn: 1, result: {} })).toBeUndefined();
    expect(
      parse_wire_event({
        type: "tool_call_end",
        turn: 1,
        call: { id: "1", name: "shell", args: {} },
      }),
    ).toBeUndefined();
    expect(parse_wire_event({ type: "final", message: { content: 1 }, result: {} })).toBeUndefined();
    expect(parse_wire_event({ type: "compress_end" })).toBeUndefined();
    expect(parse_wire_event({ type: "budget_exhausted", turns_used: "2" })).toBeUndefined();
  });

  it("accepts compress, budget, final, and cancelled tool ends", () => {
    expect(parse_wire_event({ type: "compress_end", summary_chars: 4 })).toEqual({
      type: "compress_end",
      summary_chars: 4,
      usage: undefined,
    });
    expect(parse_wire_event({ type: "budget_exhausted", turns_used: 3 })).toEqual({
      type: "budget_exhausted",
      turns_used: 3,
    });
    expect(
      parse_wire_event({
        type: "final",
        message: { content: "done" },
        result: { usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
      })?.type,
    ).toBe("final");
    expect(
      parse_wire_event({
        type: "tool_call_end",
        turn: 1,
        call: { id: "1", name: "shell", args: [] },
        result: { ok: false, output: "", error: "nope" },
        cancelled: true,
      }),
    ).toMatchObject({
      type: "tool_call_end",
      cancelled: true,
      call: { id: "1", name: "shell", args: {} },
    });
  });
});

describe("parse_submit_result", () => {
  it("accepts budget results and drops non-string reply and path", () => {
    expect(parse_submit_result(submit_payload)?.stopped_reason).toBe("budget");
    const parsed = parse_submit_result({
      ...submit_payload,
      reply: 1,
      session_path: 2,
      stopped_reason: "final",
    });
    expect(parsed?.reply).toBeUndefined();
    expect(parsed?.session_path).toBeUndefined();
    expect(parsed?.stopped_reason).toBe("final");
  });

  it("rejects malformed submit results", () => {
    expect(parse_submit_result([])).toBeUndefined();
    expect(parse_submit_result({ ...submit_payload, session_id: 1 })).toBeUndefined();
    expect(parse_submit_result({ ...submit_payload, stopped_reason: "crash" })).toBeUndefined();
    expect(parse_submit_result({ ...submit_payload, turns_used: "2" })).toBeUndefined();
    expect(parse_submit_result({ ...submit_payload, usage: { prompt_tokens: 1 } })).toBeUndefined();
  });
});
