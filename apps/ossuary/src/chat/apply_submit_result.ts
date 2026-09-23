/** Fold prompt.submit result into UiState (TUI apply_run_result analogue). */
import type { PromptSubmitResult, UiState } from "./types";

export function apply_submit_result(state: UiState, result: PromptSubmitResult): UiState {
  return {
    ...state,
    phase: "idle",
    turns_used: result.turns_used,
    session_path: result.session_path ?? state.session_path,
    last_error: result.stopped_reason === "aborted" ? "run aborted" : state.last_error,
  };
}
