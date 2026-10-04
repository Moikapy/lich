/** Prompt submit / abort RPCs (session helpers live in session/session_rpc). */
import { request_gateway } from "../gateway-client";
import { parse_submit_result } from "./parse_submit_result";
import type { PromptSubmitResult } from "./types";
import { as_record } from "./wire_guards";

export { session_create } from "../session/session_rpc";

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
