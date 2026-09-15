/**
 * Pure state logic for the ink TUI: UI-state transitions from agent events,
 * slash-command parsing, transcript block mapping, and display formatters.
 * No ink/react imports here — this module is unit-tested without a TTY.
 */
import type { AgentEvent } from "../agent/events.js";
import type { AgentRunResult } from "../agent/agent.js";
import type { AssistantMessage, Message, ToolCall, Usage } from "../providers/types.js";
import { safe_json_parse, truncate_text } from "../util/json.js";

export type UiPhase = "idle" | "thinking" | "tool";

export interface UiState {
  readonly phase: UiPhase;
  readonly turns_used: number;
  readonly usage: Usage;
  readonly session_path: string | undefined;
  readonly compress_count: number;
  readonly budget_exhausted: boolean;
  readonly last_error: string | undefined;
  readonly active_tool: ToolCall | undefined;
}

export const INITIAL_UI_STATE: UiState = {
  phase: "idle",
  turns_used: 0,
  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  session_path: undefined,
  compress_count: 0,
  budget_exhausted: false,
  last_error: undefined,
  active_tool: undefined,
};

export const HISTORY_CAP = 50;
const TOOL_ARGS_PREVIEW_CHARS = 80;
const TOOL_OUTPUT_PREVIEW_CHARS = 120;
const ERROR_PREVIEW_CHARS = 300;

function error_text(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Reducer over UiState; one pure mapping per AgentEvent variant. */
export function apply_event(state: UiState, event: AgentEvent): UiState {
  switch (event.type) {
    case "llm_start":
      return { ...state, phase: "thinking", active_tool: undefined };
    case "llm_end":
      return {
        ...state,
        usage: {
          prompt_tokens: state.usage.prompt_tokens + event.result.usage.prompt_tokens,
          completion_tokens: state.usage.completion_tokens + event.result.usage.completion_tokens,
          total_tokens: state.usage.total_tokens + event.result.usage.total_tokens,
        },
      };
    case "tool_call_start":
      return { ...state, phase: "tool", active_tool: event.call };
    case "tool_call_end":
      return {
        ...state,
        phase: "thinking",
        active_tool: undefined,
        last_error: event.result.ok === true ? state.last_error : (event.result.error ?? "tool failed"),
      };
    case "turn_end":
      return { ...state, turns_used: event.turn };
    case "compress_start":
      return { ...state, compress_count: state.compress_count + 1 };
    case "budget_exhausted":
      return { ...state, budget_exhausted: true };
    case "error":
      return { ...state, last_error: error_text(event.error) };
    default:
      return state;
  }
}

/** Fold an AgentRunResult back into UiState after the run promise resolves. */
export function apply_run_result(state: UiState, result: AgentRunResult): UiState {
  return {
    ...state,
    phase: "idle",
    turns_used: result.outcome.turns_used,
    session_path: result.session_path ?? state.session_path,
    last_error: result.outcome.stopped_reason === "aborted" ? "run aborted" : state.last_error,
  };
}

export type ParsedInput = { kind: "slash"; name: string; args: string } | { kind: "message"; text: string };

/** Split trimmed input into slash command vs plain message (empty input = message). */
export function parse_command(raw_input: string): ParsedInput {
  const text = raw_input.trim();
  if (text.startsWith("/") === false) {
    return { kind: "message", text };
  }
  const body = text.slice(1);
  const space_index = body.indexOf(" ");
  if (space_index === -1) {
    return { kind: "slash", name: body, args: "" };
  }
  return { kind: "slash", name: body.slice(0, space_index), args: body.slice(space_index + 1).trim() };
}

/** 1234567 -> "1,234,567" (US grouping, matching the status bar style). */
export function format_usage(total_tokens: number): string {
  return total_tokens.toLocaleString("en-US");
}

export type BlockRole = "user" | "lich" | "tool" | "meta" | "error";

export interface HistoryBlock {
  readonly role: BlockRole;
  readonly lines: readonly string[];
}

function assistant_tool_line(call: ToolCall): string {
  const args_json = JSON.stringify(call.args) ?? "{}";
  return `  \u23bf ${truncate_text(args_json, TOOL_ARGS_PREVIEW_CHARS)}`;
}

function format_message_lines(message: Message): string[] {
  if (message.role === "user") {
    return [`you \u203a ${message.content}`];
  }
  if (message.role === "assistant") {
    const lines = [`lich \u203a ${message.content}`];
    for (const call of message.tool_calls ?? []) {
      lines.push(assistant_tool_line(call));
    }
    return lines;
  }
  if (message.role === "tool") {
    const flag = message.is_error === true ? "error" : "ok";
    return [`  \u23bf ${message.name}: ${flag} (${truncate_text(message.content, TOOL_OUTPUT_PREVIEW_CHARS)})`];
  }
  return [`\u00b7 system: ${message.content}`];
}

/** Map one transcript Message to display lines with its role tag. */
export function format_message_block(message: Message): HistoryBlock {
  if (message.role === "tool") {
    const ok = message.is_error !== true;
    return { role: ok === true ? "tool" : "error", lines: format_message_lines(message) };
  }
  const roles: Record<Exclude<Message["role"], "tool">, BlockRole> = {
    system: "meta",
    user: "user",
    assistant: "lich",
  };
  return { role: roles[message.role], lines: format_message_lines(message) };
}

/** Keep the newest `cap` non-system messages as renderable blocks. */
export function split_history_blocks(messages: readonly Message[], cap: number): HistoryBlock[] {
  const visible = messages.filter((message) => message.role !== "system");
  const start = Math.max(0, visible.length - cap);
  return visible.slice(start).map(format_message_block);
}

function assistant_result_block(message: AssistantMessage): HistoryBlock | undefined {
  if (message.content.length === 0) {
    return undefined;
  }
  return { role: "lich", lines: [`lich \u203a ${message.content}`] };
}

/** Post-run meta blocks: compression notices, budget, errors, final answer. */
export function run_notice_blocks(result: AgentRunResult): HistoryBlock[] {
  const blocks: HistoryBlock[] = [];
  if (result.outcome.stopped_reason === "budget") {
    blocks.push({ role: "error", lines: ["\u00b7 budget exhausted (turn cap reached)"] });
  }
  const final_block = result.outcome.final === undefined ? undefined : assistant_result_block(result.outcome.final);
  if (final_block !== undefined) {
    blocks.push(final_block);
  }
  return blocks;
}

function truncate_tool_preview(result_content: string, ok: boolean): string {
  return `  \u23bf ${ok === true ? "ok" : "error"} (${truncate_text(result_content, TOOL_OUTPUT_PREVIEW_CHARS)})`;
}

/** One finalized live tool row; falls back to the transcript copy when absent. */
export function tool_result_block(call: ToolCall, ok: boolean, result_content: string): HistoryBlock {
  const args_json = JSON.stringify(call.args) ?? "{}";
  const lines = [
    `\u23fa ${call.name}(${truncate_text(args_json, TOOL_ARGS_PREVIEW_CHARS)})`,
    truncate_tool_preview(result_content, ok),
  ];
  return { role: ok === true ? "tool" : "error", lines };
}

export function parse_tool_message_content(content: string): { ok: boolean; output: string } {
  const parsed = safe_json_parse<{ ok?: unknown; output?: unknown }>(content);
  if (parsed !== undefined && typeof parsed.ok === "boolean" && typeof parsed.output === "string") {
    return { ok: parsed.ok, output: parsed.output };
  }
  return { ok: true, output: content };
}

export function compress_notice_block(summary_chars: number): HistoryBlock {
  return { role: "meta", lines: [`\u00b7 context compressed (summary ${summary_chars} chars)`] };
}

export function error_notice_block(message: string): HistoryBlock {
  return { role: "error", lines: [`\u00b7 error: ${truncate_text(message, ERROR_PREVIEW_CHARS)}`] };
}

export function tool_args_preview(args: Record<string, unknown>): string {
  const args_json = JSON.stringify(args) ?? "{}";
  return truncate_text(args_json, TOOL_ARGS_PREVIEW_CHARS);
}

export function help_block(): HistoryBlock {
  return { role: "meta", lines: [...HELP_LINES] };
}

export function model_label_block(config: { providers: readonly { model: string; kind: string }[] }): HistoryBlock {
  const provider = config.providers[0];
  return {
    role: "meta",
    lines: [`\u00b7 model: ${provider?.model ?? "unknown"} \u00b7 provider: ${provider?.kind ?? "unknown"}`],
  };
}

export function usage_notice_block(total_tokens: number): HistoryBlock {
  return { role: "meta", lines: [`\u00b7 tokens used this session: ${format_usage(total_tokens)}`] };
}

export function unknown_command_block(name: string): HistoryBlock {
  return { role: "error", lines: [`\u00b7 unknown command: /${name} (try /help)`] };
}

export interface SessionEntryInfo {
  readonly name: string;
  readonly size_bytes: number;
  readonly mtime_ms: number;
}

/** Newest-first session listing, capped at `cap` entries. */
export function session_list_block(entries: readonly SessionEntryInfo[], cap: number = 10): HistoryBlock {
  const sorted = [...entries].sort((a, b) => b.mtime_ms - a.mtime_ms).slice(0, cap);
  if (sorted.length === 0) {
    return { role: "meta", lines: ["\u00b7 no session files yet"] };
  }
  const lines: string[] = [`\u00b7 sessions (${sorted.length}):`];
  for (const entry of sorted) {
    lines.push(`  ${entry.name} (${format_usage(entry.size_bytes)} bytes)`);
  }
  return { role: "meta", lines };
}

export const SLASH_COMMAND_NAMES: readonly string[] = [
  "exit",
  "quit",
  "q",
  "help",
  "model",
  "usage",
  "clear",
  "sessions",
];

export const HELP_LINES: readonly string[] = [
  "commands: /help /model /usage /clear /sessions /exit (aliases: /quit /q)",
  "enter submits \u00b7 backspace deletes \u00b7 up/down recalls history \u00b7 pasted newlines become spaces",
];