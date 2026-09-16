/**
 * Webhook reply shape from src/gateway/format.ts. Game repo owns combat
 * fallback; this file does not invent an attack.
 */
import type { RoundFate, UsageShape } from "./types.js";

const ERROR_SNIPPET_CHARS = 300;

export function webhook_body(reply: string, usage: UsageShape | null): string {
  return JSON.stringify({ reply, usage });
}

/** Model text only. An empty budget reply is not an order. */
export function reply_text(stopped_reason: string, content: string | undefined): string {
  if (stopped_reason === "budget") {
    return content ?? "";
  }
  return content ?? "";
}

/**
 * `game_repo_decides` means the game drains `.lich/game/orders.jsonl` and
 * applies its own rules if this round wrote nothing. lich does not fill in
 * a basic attack.
 */
export function round_fate(stopped_reason: string): RoundFate {
  if (stopped_reason === "budget" || stopped_reason === "aborted") {
    return "game_repo_decides";
  }
  return "use_model_reply";
}

/** Same single-line shape as the gateway webhook so Godot needs no new branch. */
export function sanitize_agent_error(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const flat = raw.replace(/\s+/g, " ").trim();
  const detail = flat.slice(0, ERROR_SNIPPET_CHARS);
  return `agent error: ${detail.length > 0 ? detail : "unknown"}`;
}
