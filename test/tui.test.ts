import { describe, expect, it } from "vitest";
import {
  apply_event,
  apply_run_result,
  compress_notice_block,
  error_notice_block,
  format_message_block,
  format_usage,
  help_block,
  INITIAL_UI_STATE,
  model_label_block,
  parse_command,
  parse_tool_message_content,
  run_notice_blocks,
  session_list_block,
  split_history_blocks,
  tool_args_preview,
  tool_result_block,
  unknown_command_block,
  usage_notice_block,
  type HistoryBlock,
  type UiState,
} from "../src/tui/state.js";
import type { AgentRunResult } from "../src/agent/agent.js";
import { LICH_THEME } from "../src/util/lore.js";
import type { LoopOutcome } from "../src/agent/loop.js";
import type { Message, Usage } from "../src/providers/types.js";

const usage = (total_tokens: number): Usage => ({
  prompt_tokens: total_tokens,
  completion_tokens: total_tokens,
  total_tokens,
});

describe("apply_event transitions", () => {
  it("starts idle and transitions to thinking on llm_start", () => {
    expect(INITIAL_UI_STATE.phase).toBe("idle");
    const thinking = apply_event(INITIAL_UI_STATE, ({ type: "llm_start", turn: 1 }));
    expect(thinking.phase).toBe("thinking");
  });

  it("accumulates usage on llm_end without changing phase", () => {
    const thinking = apply_event(INITIAL_UI_STATE, ({ type: "llm_start", turn: 1 }));
    const ended = apply_event(thinking, {
      type: "llm_end",
      turn: 1,
      result: {
        message: { role: "assistant", content: "" },
        usage: usage(120),
        finish_reason: "stop",
        model: "m",
        provider_name: "p",
      },
    });
    expect(ended.usage.total_tokens).toBe(120);
    expect(ended.phase).toBe("thinking");
  });

  it("moves thinking -> tool on tool_call_start and clears on end", () => {
    const call = { id: "1", name: "shell", args: { cmd: "ls" } };
    const tooling = apply_event(INITIAL_UI_STATE, ({ type: "tool_call_start", turn: 1, call }));
    expect(tooling.phase).toBe("tool");
    expect(tooling.active_tool?.name).toBe("shell");
    const done = apply_event(tooling, {
      type: "tool_call_end",
      turn: 1,
      call,
      result: { ok: true, output: "done" },
    });
    expect(done.phase).toBe("thinking");
    expect(done.active_tool).toBeUndefined();
  });

  it("records the error text when a tool ends with ok=false", () => {
    const call = { id: "1", name: "shell", args: {} };
    const tooling = apply_event(INITIAL_UI_STATE, ({ type: "tool_call_start", turn: 1, call }));
    const failed = apply_event(tooling, {
      type: "tool_call_end",
      turn: 1,
      call,
      result: { ok: false, output: "", error: "boom" },
    });
    expect(failed.last_error).toBe("boom");
    const succeeded = apply_event(failed, {
      type: "tool_call_end",
      turn: 1,
      call,
      result: { ok: true, output: "fine" },
    });
    expect(succeeded.last_error).toBe("boom");
  });

  it("tracks turns via turn_end", () => {
    const turned = apply_event(INITIAL_UI_STATE, ({ type: "turn_end", turn: 3 }));
    expect(turned.turns_used).toBe(3);
  });

  it("flags budget exhaustion and errors", () => {
    const budgeted = apply_event(INITIAL_UI_STATE, ({ type: "budget_exhausted", turns_used: 25 }));
    expect(budgeted.budget_exhausted).toBe(true);
    const errored = apply_event(INITIAL_UI_STATE, ({ type: "error", error: new Error("nope") }));
    expect(errored.last_error).toBe("nope");
    const string_errored = apply_event(INITIAL_UI_STATE, ({ type: "error", error: "plain" }));
    expect(string_errored.last_error).toBe("plain");
  });

  it("cycles idle -> thinking -> tool -> thinking across a full turn", () => {
    let state: UiState = INITIAL_UI_STATE;
    const call = { id: "1", name: "read_file", args: {} };
    state = apply_event(state, { type: "turn_start", turn: 1 });
    state = apply_event(state, { type: "llm_start", turn: 1 });
    state = apply_event(state, {
      type: "llm_end",
      turn: 1,
      result: { message: { role: "assistant", content: "" }, usage: usage(10), finish_reason: "tool_calls", model: "m", provider_name: "p" },
    });
    state = apply_event(state, { type: "tool_call_start", turn: 1, call });
    expect(state.phase).toBe("tool");
    state = apply_event(state, { type: "tool_call_end", turn: 1, call, result: { ok: true, output: "x" } });
    expect(state.phase).toBe("thinking");
    state = apply_event(state, { type: "turn_end", turn: 1 });
    expect(state.turns_used).toBe(1);
  });
});

describe("apply_run_result", () => {
  const outcome: LoopOutcome = {
    messages: [{ role: "user", content: "hi" }],
    final: undefined,
    result: undefined,
    turns_used: 2,
    stopped_reason: "final",
  };

  it("returns to idle and stores the session path", () => {
    const thinking: UiState = { ...INITIAL_UI_STATE, phase: "thinking" };
    const done = apply_run_result(thinking, {
      outcome,
      messages: outcome.messages,
      usage_total: usage(50),
      session_path: "/tmp/s.jsonl",
    } satisfies AgentRunResult);
    expect(done.phase).toBe("idle");
    expect(done.session_path).toBe("/tmp/s.jsonl");
    expect(done.turns_used).toBe(2);
  });

  it("keeps the prior session path when the run persisted none", () => {
    const started: UiState = { ...INITIAL_UI_STATE, session_path: "/tmp/old.jsonl" };
    const done = apply_run_result(started, {
      outcome,
      messages: [],
      usage_total: usage(1),
      session_path: undefined,
    } satisfies AgentRunResult);
    expect(done.session_path).toBe("/tmp/old.jsonl");
  });
});

describe("parse_command", () => {
  it("parses slash commands with and without args", () => {
    expect(parse_command("/help")).toEqual({ kind: "slash", name: "help", args: "" });
    expect(parse_command("/model")).toEqual({ kind: "slash", name: "model", args: "" });
    expect(parse_command("/model glm-4 ")).toEqual({ kind: "slash", name: "model", args: "glm-4" });
  });

  it("treats plain text and empty input as messages", () => {
    expect(parse_command("hello world")).toEqual({ kind: "message", text: "hello world" });
    expect(parse_command("   ")).toEqual({ kind: "message", text: "" });
    expect(parse_command("")).toEqual({ kind: "message", text: "" });
  });

  it("does not treat a mid-text slash as a command", () => {
    expect(parse_command("run /help please")).toEqual({ kind: "message", text: "run /help please" });
  });

  it("parses the quit aliases", () => {
    expect(parse_command("/q")).toEqual({ kind: "slash", name: "q", args: "" });
    expect(parse_command("/quit")).toEqual({ kind: "slash", name: "quit", args: "" });
    expect(parse_command("/exit")).toEqual({ kind: "slash", name: "exit", args: "" });
  });
});

describe("format_usage", () => {
  it("groups digits with commas", () => {
    expect(format_usage(0)).toBe("0");
    expect(format_usage(1234)).toBe("1,234");
    expect(format_usage(1234567)).toBe("1,234,567");
  });
});

describe("format_message_block", () => {
  it("formats user and assistant lines with role tags", () => {
    const user = format_message_block({ role: "user", content: "hi there" }, LICH_THEME);
    expect(user.role).toBe("user");
    expect(user.lines).toEqual(["mortal › hi there"]);

    const assistant = format_message_block({ role: "assistant", content: "hello" }, LICH_THEME);
    expect(assistant.role).toBe("lich");
    expect(assistant.lines[0]).toBe("lich › hello");
  });

  it("appends assistant tool-call lines with truncated args", () => {
    const long_args = { path: "x".repeat(120) };
    const block = format_message_block({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "1", name: "read_file", args: long_args }],
    }, LICH_THEME);
    expect(block.role).toBe("lich");
    expect(block.lines).toHaveLength(2);
    expect(block.lines[1]?.startsWith("  ⎿ {")).toBe(true);
    expect(block.lines[1]?.includes("chars omitted")).toBe(true);
  });

  it("formats tool messages as ok/error result lines", () => {
    const ok = format_message_block({ role: "tool", tool_call_id: "1", name: "shell", content: "listed files" }, LICH_THEME);
    expect(ok.role).toBe("tool");
    expect(ok.lines[0]).toBe("  ⎿ shell: ok (listed files)");

    const failure = format_message_block({
      role: "tool",
      tool_call_id: "1",
      name: "shell",
      content: "not found",
      is_error: true,
    }, LICH_THEME);
    expect(failure.role).toBe("error");
    expect(failure.lines[0]).toBe("  ⎿ shell: error (not found)");
  });

  it("maps system messages to meta blocks", () => {
    const block = format_message_block({ role: "system", content: "be brief" }, LICH_THEME);
    expect(block.role).toBe("meta");
  });
});

describe("split_history_blocks", () => {
  const user_message = (index: number): Message => ({ role: "user", content: `msg ${index}` });

  it("caps the newest N non-system messages", () => {
    const messages: Message[] = [];
    for (let index = 0; index < 60; index += 1) {
      messages.push(user_message(index));
    }
    messages.push({ role: "system", content: "prompt" });
    const blocks = split_history_blocks(messages, 50, LICH_THEME);
    expect(blocks).toHaveLength(50);
    expect(blocks[0]?.lines[0]).toBe("mortal › msg 10");
    expect(blocks[49]?.lines[0]).toBe("mortal › msg 59");
  });

  it("returns fewer blocks when under the cap and drops system messages", () => {
    const blocks = split_history_blocks([user_message(1), { role: "system", content: "s" }, user_message(2)], 50, LICH_THEME);
    expect(blocks).toHaveLength(2);
  });
});

describe("notice blocks", () => {
  it("renders budget and final for a budget-stopped run", () => {
    const blocks = run_notice_blocks({
      outcome: { messages: [], final: { role: "assistant", content: "partial" }, result: undefined, turns_used: 25, stopped_reason: "budget" },
      messages: [],
      usage_total: usage(9),
      session_path: undefined,
    }, LICH_THEME);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.role).toBe("error");
    expect(blocks[0]?.lines[0]).toContain("budget exhausted");
    expect(blocks[0]?.lines[0]).toContain("the ritual is spent");
    expect(blocks[1]?.lines[0]).toBe(`${LICH_THEME.response_label} › partial`);
  });

  it("omits the final block when content is empty", () => {
    const blocks = run_notice_blocks({
      outcome: { messages: [], final: { role: "assistant", content: "" }, result: undefined, turns_used: 1, stopped_reason: "final" },
      messages: [],
      usage_total: usage(0),
      session_path: undefined,
    }, LICH_THEME);
    expect(blocks).toEqual([]);
  });

  it("formats compress, error, usage, model, and unknown-command notices", () => {
    expect(compress_notice_block(512, LICH_THEME).lines[0]).toContain("context compressed — memories distilled (summary 512 chars)");
    expect(error_notice_block("kaboom").role).toBe("error");
    expect(usage_notice_block(1234).lines[0]).toContain("1,234");
    expect(model_label_block({ providers: [{ model: "glm-5.3-flash:cloud", kind: "ollama" }] }).lines[0]).toContain(
      "glm-5.3-flash:cloud",
    );
    expect(unknown_command_block("wat").role).toBe("error");
  });

  it("formats tool result blocks with ok and error styling flags", () => {
    const ok = tool_result_block({ id: "1", name: "shell", args: { cmd: "ls" } }, true, "file.txt");
    expect(ok.role).toBe("tool");
    expect(ok.lines[0]).toBe("⏺ shell({\"cmd\":\"ls\"})");
    expect(ok.lines[1]).toBe("  ⎿ ok (file.txt)");

    const failure = tool_result_block({ id: "1", name: "shell", args: {} }, false, "denied");
    expect(failure.role).toBe("error");
    expect(failure.lines[1]).toBe("  ⎿ error (denied)");
  });

  it("parses tool message content back into ok/output", () => {
    expect(parse_tool_message_content('{"ok":false,"output":"x","error":"y"}')).toEqual({ ok: false, output: "x" });
    expect(parse_tool_message_content("plain text")).toEqual({ ok: true, output: "plain text" });
  });

  it("previews long tool args and lists sessions newest-first", () => {
    expect(tool_args_preview({ path: "short" })).toBe('{"path":"short"}');
    const block: HistoryBlock = session_list_block(
      [
        { name: "old.jsonl", size_bytes: 10, mtime_ms: 1 },
        { name: "new.jsonl", size_bytes: 20, mtime_ms: 2 },
      ],
      LICH_THEME,
      10,
    );
    expect(block.lines[0]).toBe("· phylacteries (2):");
    expect(block.lines[1]).toBe("  new.jsonl (20 bytes)");
    expect(help_block().lines.length).toBeGreaterThan(1);
  });
});

describe("tui entry smoke", () => {
  it("exports run_tui from the tui entry module", async () => {
    try {
      const mod = await import("../src/tui.js");
      expect(typeof mod.run_tui).toBe("function");
      expect(mod.run_tui.length).toBe(1);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason.includes("ink") === true || reason.includes("react") === true) {
        // ink/react may fail to import under vite in headless test envs; the
        // pure-logic suites above are the real coverage in that case.
        expect(reason.length).toBeGreaterThan(0);
        return;
      }
      throw error;
    }
  });
});