/** Parse prompt.submit JSON-RPC result into PromptSubmitResult. */
import type { PromptSubmitResult } from "./types";
import { as_record } from "./wire_guards";

export function parse_submit_result(value: unknown): PromptSubmitResult | undefined {
  const record = as_record(value);
  if (record === undefined || typeof record.session_id !== "string") {
    return undefined;
  }
  if (
    typeof record.turns_used !== "number" ||
    (record.stopped_reason !== "final" &&
      record.stopped_reason !== "budget" &&
      record.stopped_reason !== "aborted")
  ) {
    return undefined;
  }
  const usage = as_record(record.usage);
  if (
    usage === undefined ||
    typeof usage.prompt_tokens !== "number" ||
    typeof usage.completion_tokens !== "number" ||
    typeof usage.total_tokens !== "number"
  ) {
    return undefined;
  }
  return {
    session_id: record.session_id,
    reply: typeof record.reply === "string" ? record.reply : undefined,
    usage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
    },
    session_path: typeof record.session_path === "string" ? record.session_path : undefined,
    turns_used: record.turns_used,
    stopped_reason: record.stopped_reason,
  };
}
