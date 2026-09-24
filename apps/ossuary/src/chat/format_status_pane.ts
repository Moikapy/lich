/** Status pane lines — TUI status bar analogue (model / phase / turns / tokens / path). */
import type { ConnectionInfo } from "../gateway-client";
import type { UiState } from "./types";

export interface StatusPaneFields {
  model: string;
  phase: string;
  turns: string;
  tokens: string;
  session_path: string;
  connection: string;
}

/** Format token counts with US grouping, matching the TUI status bar. */
export function format_token_count(total: number): string {
  return total.toLocaleString("en-US");
}

export function format_status_pane_fields(
  connection: ConnectionInfo,
  ui: UiState,
  model: string,
): StatusPaneFields {
  const connection_label =
    connection.status === "error"
      ? `error: ${connection.error ?? "gateway"}`
      : connection.status;

  return {
    model,
    phase: ui.phase,
    turns: String(ui.turns_used),
    tokens: format_token_count(ui.usage.total_tokens),
    session_path: ui.session_path ?? "—",
    connection: connection_label,
  };
}
