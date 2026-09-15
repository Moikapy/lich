/**
 * Gateway reply formatting: per-platform shaping and whitespace-aware
 * splitting for size-capped transports (telegram 4096, discord 2000, …).
 */
import type { Usage } from "../providers/types.js";

const USAGE_FOOTER_PREFIX = "\n\n_tokens: ";

export function format_agent_reply(text: string, usage: Usage | undefined, platform: string): string {
  if (platform === "webhook") {
    return JSON.stringify({ reply: text, usage: usage ?? null });
  }
  const total_tokens = usage?.total_tokens ?? 0;
  if (total_tokens > 0) {
    return `${text}${USAGE_FOOTER_PREFIX}${total_tokens}_`;
  }
  return text;
}

/** Splits text into chunks of at most `limit` chars, preferring whitespace. */
export function split_text(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const cut = find_split_point(rest, limit);
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) {
    chunks.push(rest);
  }
  return chunks;
}

/** Last newline or space inside the window; falls back to a hard cut. */
function find_split_point(text: string, limit: number): number {
  const window = text.slice(0, limit + 1);
  const newline = window.lastIndexOf("\n");
  if (newline > 0) {
    return newline;
  }
  const space = window.lastIndexOf(" ");
  if (space > 0) {
    return space;
  }
  return limit;
}