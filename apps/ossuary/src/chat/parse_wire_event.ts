/** Decode wire AgentEvent variants from JSON-RPC notification payloads. */
import {
  parse_compress_end,
  parse_final,
  parse_llm_end,
  parse_tool_end,
  parse_tool_start,
} from "./parse_wire_kinds";
import { as_record } from "./wire_guards";
import type { WireAgentEvent } from "./types";

export function parse_wire_event(value: unknown): WireAgentEvent | undefined {
  const record = as_record(value);
  if (record === undefined || typeof record.type !== "string") {
    return undefined;
  }
  switch (record.type) {
    case "turn_start":
    case "llm_start":
    case "turn_end":
      return typeof record.turn === "number" ? { type: record.type, turn: record.turn } : undefined;
    case "llm_end":
      return parse_llm_end(record);
    case "tool_call_start":
      return parse_tool_start(record);
    case "tool_call_end":
      return parse_tool_end(record);
    case "compress_start":
      return typeof record.estimated_tokens === "number"
        ? { type: "compress_start", estimated_tokens: record.estimated_tokens }
        : undefined;
    case "compress_end":
      return parse_compress_end(record);
    case "final":
      return parse_final(record);
    case "budget_exhausted":
      return typeof record.turns_used === "number"
        ? { type: "budget_exhausted", turns_used: record.turns_used }
        : undefined;
    case "error":
      return { type: "error", error: record.error };
    default:
      return undefined;
  }
}
