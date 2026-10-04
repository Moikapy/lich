/** Narrow unknown JSON values used by serve event parsing. */
import type { ToolCall, ToolResult, Usage } from "./types";

export function as_record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function as_usage(value: unknown): Usage | undefined {
  const record = as_record(value);
  if (record === undefined) {
    return undefined;
  }
  if (
    typeof record.prompt_tokens !== "number" ||
    typeof record.completion_tokens !== "number" ||
    typeof record.total_tokens !== "number"
  ) {
    return undefined;
  }
  return {
    prompt_tokens: record.prompt_tokens,
    completion_tokens: record.completion_tokens,
    total_tokens: record.total_tokens,
  };
}

export function as_tool_call(value: unknown): ToolCall | undefined {
  const record = as_record(value);
  if (record === undefined) {
    return undefined;
  }
  if (typeof record.id !== "string" || typeof record.name !== "string") {
    return undefined;
  }
  const args = as_record(record.args) ?? {};
  return { id: record.id, name: record.name, args };
}

export function as_tool_result(value: unknown): ToolResult | undefined {
  const record = as_record(value);
  if (record === undefined || typeof record.ok !== "boolean" || typeof record.output !== "string") {
    return undefined;
  }
  return {
    ok: record.ok,
    output: record.output,
    error: typeof record.error === "string" ? record.error : undefined,
  };
}
