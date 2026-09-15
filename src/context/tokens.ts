/**
 * Rough token estimation helpers used for context-budget decisions.
 *
 * The ~4 chars-per-token heuristic is intentionally coarse: it only needs to
 * be good enough to decide when conversation history should be compressed.
 */
import type { Message } from "../providers/types.js";
import { safe_stringify } from "../util/json.js";

const TOOL_MESSAGE_OVERHEAD_TOKENS = 8;

export function estimate_text_tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimate_message_tokens(message: Message): number {
  const content_tokens = estimate_text_tokens(message.content);
  if (message.role === "assistant" && message.tool_calls !== undefined) {
    return content_tokens + estimate_text_tokens(safe_stringify(message.tool_calls));
  }
  if (message.role === "tool") {
    return content_tokens + TOOL_MESSAGE_OVERHEAD_TOKENS;
  }
  return content_tokens;
}

export function estimate_messages_tokens(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + estimate_message_tokens(message), 0);
}