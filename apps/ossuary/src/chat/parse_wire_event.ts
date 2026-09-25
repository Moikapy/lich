/** Decode wire AgentEvent variants from JSON-RPC notification payloads. */
import {
  parse_compress_end,
  parse_final,
  parse_llm_end,
  parse_tool_end,
  parse_tool_start,
} from "./parse_wire_kinds";
import { as_record } from "./wire_guards";
import type { WireAgentEvent, WireAgentEventBody, WireEnvelopeFields } from "./types";

function parse_envelope(record: Record<string, unknown>): WireEnvelopeFields {
  const fields: WireEnvelopeFields = {};
  if (typeof record.run_id === "string") {
    fields.run_id = record.run_id;
  }
  if (typeof record.session_id === "string") {
    fields.session_id = record.session_id;
  }
  if (typeof record.seq === "number") {
    fields.seq = record.seq;
  }
  if (typeof record.ts === "number") {
    fields.ts = record.ts;
  }
  return fields;
}

function with_envelope(
  record: Record<string, unknown>,
  body: WireAgentEventBody,
): WireAgentEvent {
  return { ...body, ...parse_envelope(record) };
}

function parse_run_end(record: Record<string, unknown>): WireAgentEventBody | undefined {
  const reason = record.stopped_reason;
  if (
    (reason === "final" || reason === "budget" || reason === "aborted") &&
    typeof record.turns_used === "number"
  ) {
    return { type: "run_end", stopped_reason: reason, turns_used: record.turns_used };
  }
  return undefined;
}

export function parse_wire_event(value: unknown): WireAgentEvent | undefined {
  const record = as_record(value);
  if (record === undefined || typeof record.type !== "string") {
    return undefined;
  }
  let body: WireAgentEventBody | undefined;
  switch (record.type) {
    case "turn_start":
    case "llm_start":
    case "turn_end":
      body = typeof record.turn === "number" ? { type: record.type, turn: record.turn } : undefined;
      break;
    case "llm_end":
      body = parse_llm_end(record);
      break;
    case "tool_call_start":
      body = parse_tool_start(record);
      break;
    case "tool_call_end":
      body = parse_tool_end(record);
      break;
    case "compress_start":
      body =
        typeof record.estimated_tokens === "number"
          ? { type: "compress_start", estimated_tokens: record.estimated_tokens }
          : undefined;
      break;
    case "compress_end":
      body = parse_compress_end(record);
      break;
    case "final":
      body = parse_final(record);
      break;
    case "budget_exhausted":
      body =
        typeof record.turns_used === "number"
          ? { type: "budget_exhausted", turns_used: record.turns_used }
          : undefined;
      break;
    case "run_start":
      body = { type: "run_start" };
      break;
    case "run_end":
      body = parse_run_end(record);
      break;
    case "error":
      body = { type: "error", error: record.error };
      break;
    default:
      return undefined;
  }
  if (body === undefined) {
    return undefined;
  }
  return with_envelope(record, body);
}
