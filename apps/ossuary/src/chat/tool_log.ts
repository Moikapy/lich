/** Pure tool_log list reducer from tool_call_start / tool_call_end events. */
import type { ToolCall, ToolResult, WireAgentEvent } from "./types";

export const TOOL_LOG_CAP = 100;

export type ToolLogStatus = "running" | "ok" | "error" | "cancelled";

export interface ToolLogEntry {
  readonly id: string;
  readonly turn: number;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly status: ToolLogStatus;
  readonly output?: string;
  readonly error?: string;
}

function entry_from_call(
  turn: number,
  call: ToolCall,
  status: ToolLogStatus,
  result?: ToolResult,
  cancelled?: boolean,
): ToolLogEntry {
  return {
    id: call.id,
    turn,
    name: call.name,
    args: call.args,
    status: cancelled === true ? "cancelled" : status,
    output: result?.output,
    error: result?.error,
  };
}

function upsert(entries: readonly ToolLogEntry[], next: ToolLogEntry): readonly ToolLogEntry[] {
  const index = entries.findIndex((item) => item.id === next.id);
  if (index < 0) {
    return [...entries, next].slice(-TOOL_LOG_CAP);
  }
  const copy = [...entries];
  copy[index] = next;
  return copy;
}

/** Append or update tool_log rows for tool_call_* wire events; ignore others. */
export function apply_tool_log_event(
  entries: readonly ToolLogEntry[],
  event: WireAgentEvent,
): readonly ToolLogEntry[] {
  if (event.type === "tool_call_start") {
    return upsert(entries, entry_from_call(event.turn, event.call, "running"));
  }
  if (event.type === "tool_call_end") {
    const status: ToolLogStatus =
      event.cancelled === true ? "cancelled" : event.result.ok === true ? "ok" : "error";
    return upsert(
      entries,
      entry_from_call(event.turn, event.call, status, event.result, event.cancelled),
    );
  }
  return entries;
}
