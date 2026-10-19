/**
 * Pure state logic for the ink TUI: UI-state transitions from agent events,
 * slash-command parsing, transcript block mapping, and display formatters.
 * No ink/react imports here — this module is unit-tested without a TTY.
 */
import type { AgentEventBody } from "../agent/events.js";
import type { AgentRunResult } from "../agent/agent.js";
import { reply_after_abort } from "../agent/loop.js";
import type { AssistantMessage, Message, ToolCall, Usage } from "../providers/types.js";
import { safe_json_parse, truncate_text } from "../util/json.js";
import type { ThemeSpec } from "../util/lore.js";
import { fill_template } from "../util/theme.js";

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
  if (error !== null && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return String(error);
}

/** Reducer over UiState; one pure mapping per AgentEvent body variant. */
export function apply_event(state: UiState, event: AgentEventBody): UiState {
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
    case "compress_end":
      if (event.usage === undefined) {
        return state;
      }
      return {
        ...state,
        usage: {
          prompt_tokens: state.usage.prompt_tokens + event.usage.prompt_tokens,
          completion_tokens: state.usage.completion_tokens + event.usage.completion_tokens,
          total_tokens: state.usage.total_tokens + event.usage.total_tokens,
        },
      };
    case "tool_call_start":
      return { ...state, phase: "tool", active_tool: event.call };
    case "tool_call_end":
      return {
        ...state,
        phase: "thinking",
        active_tool: undefined,
        last_error:
          event.cancelled === true || event.result.ok === true
            ? state.last_error
            : (event.result.error ?? "tool failed"),
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

/** Dim header: the theme welcome string, the one tagline placement. */
export function tui_banner_text(theme: ThemeSpec, version: string, model: string, kind: string): string {
  return fill_template(theme.welcome, { version, model, kind });
}

/** Count messages shown in the resume banner (matches split_history_blocks visibility). */
export function resume_banner_count(messages: readonly Message[] | undefined): number {
  if (messages === undefined) {
    return 0;
  }
  return messages.filter((message) => message.role !== "system").length;
}

/** Second banner line when a session transcript was loaded via `--resume` or `/resume`. */
export function resume_banner_line(id: string, message_count: number): string {
  return `resumed ${id} (${message_count} messages)`;
}

/** 1234567 -> "1,234,567" (US grouping, matching the status bar style). */
export function format_usage(total_tokens: number): string {
  return total_tokens.toLocaleString("en-US");
}

export type BlockRole = "user" | "lich" | "tool" | "meta" | "error";

/**
 * One transcript entry. `label` is the speaker (theme user/response label) on
 * user and lich blocks; the view draws it, so `lines` hold only the content.
 * Tool blocks are one `✓`/`✗` row each; the view adds the `┊` guide.
 */
export interface HistoryBlock {
  readonly role: BlockRole;
  readonly lines: readonly string[];
  readonly label?: string;
}

/** Cut to `max_chars` on one line, ending in `…`; rows must not wrap onto a truncation notice. */
function clip(text: string, max_chars: number): string {
  return text.length <= max_chars ? text : `${text.slice(0, max_chars - 1)}\u2026`;
}

/** Args most tools are identified by, in the order they are tried. */
const PRIMARY_ARG_KEYS: readonly string[] = ["path", "file_path", "command", "cmd", "url", "query", "pattern", "name"];

/** The one arg that identifies a call (`src/app.ts`, `npm test`), else compact JSON; "" for no args. */
export function tool_args_summary(args: Record<string, unknown>): string {
  for (const key of PRIMARY_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) {
      return clip(value.replaceAll("\n", " "), TOOL_ARGS_PREVIEW_CHARS);
    }
  }
  return Object.keys(args).length === 0 ? "" : clip(JSON.stringify(args) ?? "{}", TOOL_ARGS_PREVIEW_CHARS);
}

/** 240 -> "0.2s", 65_000 -> "1m 5s". */
export function format_duration(ms: number): string {
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** First non-empty line of a tool result, truncated for a one-row preview. */
function output_preview(output: string): string {
  const first = output.split("\n").find((line) => line.trim().length > 0) ?? "";
  return clip(first.trim(), TOOL_OUTPUT_PREVIEW_CHARS);
}

/**
 * What a row previews: the output, or the error when a failure left output
 * empty (read_file, the guard and unknown tools put the reason only there).
 */
export function result_preview_text(result: { output: string; error?: string }): string {
  return result.output.length > 0 ? result.output : (result.error ?? "");
}

/**
 * `result_preview_text` for a stored tool message. Only failures are stored
 * as `{ok: false, output, error}` JSON (`format_tool_result_content`); any
 * other content, JSON-looking or not, is the raw output.
 */
function stored_result_text(content: string): string {
  const parsed = safe_json_parse<unknown>(content);
  if (typeof parsed !== "object" || parsed === null) {
    return content;
  }
  const record = parsed as { ok?: unknown; output?: unknown; error?: unknown };
  if (record.ok !== false || typeof record.output !== "string") {
    return content;
  }
  return result_preview_text({ output: record.output, error: typeof record.error === "string" ? record.error : undefined });
}

/** `✓ name  summary  0.2s · first output line` (summary, duration and preview are optional). */
function tool_row(name: string, summary: string, ok: boolean, output: string, duration_ms?: number): string {
  const parts = [`${ok === true ? "\u2713" : "\u2717"} ${name}`];
  if (summary.length > 0) {
    parts.push(summary);
  }
  if (duration_ms !== undefined) {
    parts.push(format_duration(duration_ms));
  }
  const preview = output_preview(output);
  return preview.length > 0 ? `${parts.join("  ")} \u00b7 ${preview}` : parts.join("  ");
}

/**
 * Map one transcript Message to a block. Pass the assistant `call` a tool
 * message answers so its row can name the call's main arg.
 */
export function format_message_block(message: Message, theme: ThemeSpec, call?: ToolCall): HistoryBlock {
  if (message.role === "tool") {
    const ok = message.is_error !== true;
    const summary = call === undefined ? "" : tool_args_summary(call.args);
    return { role: ok === true ? "tool" : "error", lines: [tool_row(message.name, summary, ok, stored_result_text(message.content))] };
  }
  if (message.role === "user") {
    return { role: "user", label: theme.user_label, lines: [message.content] };
  }
  if (message.role === "assistant") {
    return { role: "lich", label: theme.response_label, lines: [message.content] };
  }
  return { role: "meta", lines: [`\u00b7 system: ${message.content}`] };
}

/**
 * Keep the newest `cap` non-system messages as renderable blocks. An assistant
 * turn that only calls tools shows no reply block; its calls appear on the
 * tool rows that answer them.
 */
export function split_history_blocks(messages: readonly Message[], cap: number, theme: ThemeSpec): HistoryBlock[] {
  const calls = new Map<string, ToolCall>();
  for (const message of messages) {
    for (const call of message.role === "assistant" ? (message.tool_calls ?? []) : []) {
      calls.set(call.id, call);
    }
  }
  const visible = messages.filter(
    (message) => message.role !== "system" && (message.role !== "assistant" || message.content.length > 0),
  );
  const start = Math.max(0, visible.length - cap);
  return visible
    .slice(start)
    .map((message) => format_message_block(message, theme, message.role === "tool" ? calls.get(message.tool_call_id) : undefined));
}

/** Meta notice + transcript blocks after a successful in-TUI `/resume`. */
export function resume_session_view(
  id: string,
  messages: readonly Message[],
  theme: ThemeSpec,
  cap: number = HISTORY_CAP,
): { blocks: readonly HistoryBlock[]; banner_line: string } {
  const banner_line = resume_banner_line(id, resume_banner_count(messages));
  const notice: HistoryBlock = { role: "meta", lines: [`\u00b7 ${banner_line}`] };
  const history_cap = Math.max(0, cap - 1);
  return { blocks: [notice, ...split_history_blocks(messages, history_cap, theme)], banner_line };
}

/** Missing `/resume` argument notice. */
export function resume_missing_args_block(): HistoryBlock {
  return { role: "error", lines: ["\u00b7 /resume requires <id|latest>"] };
}

function assistant_result_block(message: AssistantMessage, theme: ThemeSpec): HistoryBlock | undefined {
  if (message.content.length === 0) {
    return undefined;
  }
  return { role: "lich", label: theme.response_label, lines: [message.content] };
}

/** Post-run meta blocks: compression notices, budget, errors, final answer. */
export function run_notice_blocks(result: AgentRunResult, theme: ThemeSpec): HistoryBlock[] {
  const blocks: HistoryBlock[] = [];
  if (result.outcome.stopped_reason === "budget") {
    blocks.push({ role: "error", lines: [`\u00b7 ${fill_template(theme.notices.budget_exhausted, {})}`] });
  }
  if (result.outcome.stopped_reason === "aborted") {
    // `final` on abort is the last assistant so far; show it only if this run wrote it.
    const reply = reply_after_abort(result.outcome);
    const reply_block = reply === undefined ? undefined : assistant_result_block(reply, theme);
    return [...blocks, ...(reply_block === undefined ? [] : [reply_block]), { role: "error", lines: ["\u00b7 run cancelled"] }];
  }
  const final_block = result.outcome.final === undefined ? undefined : assistant_result_block(result.outcome.final, theme);
  if (final_block !== undefined) {
    blocks.push(final_block);
  }
  return blocks;
}

/** One finished live tool call as a single row, with its run time when known. */
export function tool_result_block(call: ToolCall, ok: boolean, result_content: string, duration_ms?: number): HistoryBlock {
  return {
    role: ok === true ? "tool" : "error",
    lines: [tool_row(call.name, tool_args_summary(call.args), ok, result_content, duration_ms)],
  };
}

export function parse_tool_message_content(content: string): { ok: boolean; output: string } {
  const parsed = safe_json_parse<{ ok?: unknown; output?: unknown }>(content);
  if (parsed !== undefined && typeof parsed.ok === "boolean" && typeof parsed.output === "string") {
    return { ok: parsed.ok, output: parsed.output };
  }
  return { ok: true, output: content };
}

export function compress_notice_block(summary_chars: number, theme: ThemeSpec): HistoryBlock {
  const line = fill_template(theme.notices.compressed, { chars: summary_chars });
  return { role: "meta", lines: [`\u00b7 ${line}`] };
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

interface ChatProviderView {
  providers: readonly { name?: string; model: string; kind: string }[];
  models?: { chat?: readonly string[] };
}

/** First provider of the main chat chain: `models.chat[0]` when set, else `providers[0]`. */
export function chat_provider(config: ChatProviderView): { model: string; kind: string } | undefined {
  const first = config.models?.chat?.[0];
  if (first === undefined) {
    return config.providers[0];
  }
  return config.providers.find((provider) => provider.name === first);
}

export function model_label_block(config: ChatProviderView): HistoryBlock {
  const provider = chat_provider(config);
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
export function session_list_block(entries: readonly SessionEntryInfo[], theme: ThemeSpec, cap: number = 10): HistoryBlock {
  const sorted = [...entries].sort((a, b) => b.mtime_ms - a.mtime_ms).slice(0, cap);
  if (sorted.length === 0) {
    return { role: "meta", lines: ["\u00b7 no session files yet"] };
  }
  const label = fill_template(theme.notices.sessions, { count: sorted.length });
  const lines: string[] = [`\u00b7 ${label}`];
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
  "resume",
];

export const HELP_LINES: readonly string[] = [
  "commands: /help /model /usage /clear /sessions /resume /exit (aliases: /quit /q)",
  "enter submits \u00b7 backspace deletes \u00b7 up/down recalls history \u00b7 pasted newlines become spaces \u00b7 esc cancels a running turn",
];