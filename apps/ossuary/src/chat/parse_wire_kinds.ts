/** Kind-specific wire event parsers for AgentEvent JSON payloads. */
import { as_record, as_tool_call, as_tool_result, as_usage } from "./wire_guards";
import type { WireAgentEventBody } from "./types";

export function parse_llm_end(record: Record<string, unknown>): WireAgentEventBody | undefined {
  const result = as_record(record.result);
  const usage = result === undefined ? undefined : as_usage(result.usage);
  return typeof record.turn === "number" && usage !== undefined
    ? { type: "llm_end", turn: record.turn, result: { usage } }
    : undefined;
}

export function parse_tool_start(record: Record<string, unknown>): WireAgentEventBody | undefined {
  const call = as_tool_call(record.call);
  return typeof record.turn === "number" && call !== undefined
    ? { type: "tool_call_start", turn: record.turn, call }
    : undefined;
}

export function parse_tool_end(record: Record<string, unknown>): WireAgentEventBody | undefined {
  const call = as_tool_call(record.call);
  const result = as_tool_result(record.result);
  return typeof record.turn === "number" && call !== undefined && result !== undefined
    ? {
        type: "tool_call_end",
        turn: record.turn,
        call,
        result,
        cancelled: record.cancelled === true ? true : undefined,
      }
    : undefined;
}

export function parse_compress_end(record: Record<string, unknown>): WireAgentEventBody | undefined {
  return typeof record.summary_chars === "number"
    ? {
        type: "compress_end",
        summary_chars: record.summary_chars,
        usage: as_usage(record.usage),
      }
    : undefined;
}

export function parse_final(record: Record<string, unknown>): WireAgentEventBody | undefined {
  const message = as_record(record.message);
  const result = as_record(record.result);
  const usage = result === undefined ? undefined : as_usage(result.usage);
  return message !== undefined && typeof message.content === "string" && usage !== undefined
    ? { type: "final", message: { content: message.content }, result: { usage } }
    : undefined;
}
