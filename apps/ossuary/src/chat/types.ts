/**
 * Ink-free chat UI types mirrored from TUI state semantics.
 * Wire events are JSON-shaped (no Error instances after WS).
 */

export type UiPhase = "idle" | "thinking" | "tool";

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  error?: string;
}

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

export type BlockRole = "user" | "lich" | "tool" | "meta" | "error";

export interface HistoryBlock {
  readonly role: BlockRole;
  readonly lines: readonly string[];
}

/** Optional run/session envelope fields from serve AgentEvent notifications. */
export type WireEnvelopeFields = {
  run_id?: string;
  session_id?: string;
  seq?: number;
  ts?: number;
};

/** Subset of AgentEvent fields needed after JSON-RPC notification decode. */
export type WireAgentEventBody =
  | { type: "turn_start"; turn: number }
  | { type: "llm_start"; turn: number }
  | {
      type: "llm_end";
      turn: number;
      result: { usage: Usage };
    }
  | { type: "tool_call_start"; turn: number; call: ToolCall }
  | {
      type: "tool_call_end";
      turn: number;
      call: ToolCall;
      result: ToolResult;
      cancelled?: boolean;
    }
  | { type: "compress_start"; estimated_tokens: number }
  | { type: "compress_end"; summary_chars: number; usage?: Usage }
  | { type: "turn_end"; turn: number }
  | { type: "final"; message: { content: string }; result: { usage: Usage } }
  | { type: "budget_exhausted"; turns_used: number }
  | { type: "run_start" }
  | {
      type: "run_end";
      stopped_reason: "final" | "budget" | "aborted" | "error";
      turns_used: number;
    }
  | { type: "error"; error: unknown };

export type WireAgentEvent = WireAgentEventBody & WireEnvelopeFields;

export interface PromptSubmitResult {
  session_id: string;
  reply: string | undefined;
  usage: Usage;
  session_path: string | undefined;
  turns_used: number;
  stopped_reason: "final" | "budget" | "aborted";
}
