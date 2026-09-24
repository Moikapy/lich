/** Typed serve session / prompt RPC helpers for the Chat pane. */
import { request_gateway } from "../gateway-client";
import { parse_submit_result } from "./parse_submit_result";
import type { PromptSubmitResult } from "./types";
import { as_record } from "./wire_guards";

export async function session_create(source: string, label?: string): Promise<string> {
  const params: Record<string, unknown> = { source };
  if (label !== undefined) {
    params.label = label;
  }
  const result = await request_gateway("session.create", params);
  const record = as_record(result);
  if (record === undefined || typeof record.session_id !== "string") {
    throw new Error("unexpected session.create result");
  }
  return record.session_id;
}

export async function prompt_submit(session_id: string, text: string): Promise<PromptSubmitResult> {
  const result = await request_gateway("prompt.submit", { session_id, text });
  const parsed = parse_submit_result(result);
  if (parsed === undefined) {
    throw new Error("unexpected prompt.submit result");
  }
  return parsed;
}

export async function prompt_abort(session_id: string): Promise<boolean> {
  const result = await request_gateway("prompt.abort", { session_id });
  const record = as_record(result);
  if (record === undefined || typeof record.aborted !== "boolean") {
    throw new Error("unexpected prompt.abort result");
  }
  return record.aborted;
}
