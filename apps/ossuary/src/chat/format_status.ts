/** Status line for the Chat pane header. */
import type { ConnectionInfo } from "../gateway-client";
import type { UiState } from "./types";

export function format_chat_status(
  connection: ConnectionInfo,
  session_id: string | undefined,
  session_error: string | undefined,
  ui: UiState,
): string {
  if (connection.status !== "connected") {
    return connection.status === "error"
      ? `error: ${connection.error ?? "gateway"}`
      : connection.status;
  }
  if (session_error !== undefined) {
    return `session error: ${session_error}`;
  }
  if (session_id === undefined) {
    return "connected · creating session…";
  }
  const parts = [`connected · ${ui.phase}`, `session ${session_id.slice(0, 8)}`];
  if (ui.turns_used > 0) {
    parts.push(`turns ${ui.turns_used}`);
  }
  if (ui.usage.total_tokens > 0) {
    parts.push(`tokens ${ui.usage.total_tokens.toLocaleString("en-US")}`);
  }
  if (ui.last_error !== undefined) {
    parts.push(`err ${ui.last_error}`);
  }
  return parts.join(" · ");
}
