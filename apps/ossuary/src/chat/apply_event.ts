/** Pure UiState reducer — same semantics as src/tui/state.ts apply_event. */
import type { UiState, WireAgentEvent } from "./types";
import { error_text } from "./error_text";

export function apply_event(state: UiState, event: WireAgentEvent): UiState {
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
