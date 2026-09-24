/** Pure tool_log list reducer from tool_call_start / tool_call_end events. */
import type { ToolCall, ToolResult, WireAgentEvent } from "./types";

export const TOOL_LOG_CAP = 100;

export type ToolLogStatus = "running" | "ok" | "error" | "cancelled";

export interface ToolLogEntry {
  /** Stable React / upsert key; survives empty or repeated provider call ids. */
  readonly key: string;
  readonly id: string;
  readonly turn: number;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly status: ToolLogStatus;
  readonly output?: string;
  readonly error?: string;
}

export function tool_log_entry_key(turn: number, call: ToolCall, slot: number): string {
  return `${turn}:${call.id}:${slot}`;
}

function entry_from_call(
  key: string,
  turn: number,
  call: ToolCall,
  status: ToolLogStatus,
  result?: ToolResult,
  cancelled?: boolean,
): ToolLogEntry {
  return {
    key,
    id: call.id,
    turn,
    name: call.name,
    args: call.args,
    status: cancelled === true ? "cancelled" : status,
    output: result?.output,
    error: result?.error,
  };
}

/** Latest running row with the same provider id + name (and turn when present). */
function find_running_index(
  entries: readonly ToolLogEntry[],
  turn: number,
  call: ToolCall,
): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const item = entries[index];
    if (
      item !== undefined &&
      item.status === "running" &&
      item.turn === turn &&
      item.id === call.id &&
      item.name === call.name
    ) {
      return index;
    }
  }
  return -1;
}

function append(entries: readonly ToolLogEntry[], next: ToolLogEntry): readonly ToolLogEntry[] {
  return [...entries, next].slice(-TOOL_LOG_CAP);
}

/** Append or update tool_log rows for tool_call_* wire events; ignore others. */
export function apply_tool_log_event(
  entries: readonly ToolLogEntry[],
  event: WireAgentEvent,
): readonly ToolLogEntry[] {
  if (event.type === "tool_call_start") {
    const key = tool_log_entry_key(event.turn, event.call, entries.length);
    return append(entries, entry_from_call(key, event.turn, event.call, "running"));
  }
  if (event.type === "tool_call_end") {
    const status: ToolLogStatus =
      event.cancelled === true ? "cancelled" : event.result.ok === true ? "ok" : "error";
    const index = find_running_index(entries, event.turn, event.call);
    if (index < 0) {
      const key = tool_log_entry_key(event.turn, event.call, entries.length);
      return append(
        entries,
        entry_from_call(key, event.turn, event.call, status, event.result, event.cancelled),
      );
    }
    const prior = entries[index];
    if (prior === undefined) {
      return entries;
    }
    const copy = [...entries];
    copy[index] = entry_from_call(
      prior.key,
      event.turn,
      event.call,
      status,
      event.result,
      event.cancelled,
    );
    return copy;
  }
  return entries;
}
