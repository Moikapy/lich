/** Transcript block builders — Ink-free copies of TUI helpers used by Chat. */
import type { HistoryBlock, ToolCall } from "./types";

const TOOL_ARGS_PREVIEW_CHARS = 80;
const TOOL_OUTPUT_PREVIEW_CHARS = 120;
const ERROR_PREVIEW_CHARS = 300;

export function truncate_text(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function user_block(text: string): HistoryBlock {
  return { role: "user", lines: [`you › ${text}`] };
}

export function reply_block(text: string): HistoryBlock {
  return { role: "lich", lines: [`lich › ${text}`] };
}

export function error_notice_block(message: string): HistoryBlock {
  return { role: "error", lines: [`· error: ${truncate_text(message, ERROR_PREVIEW_CHARS)}`] };
}

export function budget_notice_block(): HistoryBlock {
  return { role: "error", lines: ["· turn budget exhausted"] };
}

export function tool_result_block(call: ToolCall, ok: boolean, result_content: string): HistoryBlock {
  const args_json = JSON.stringify(call.args) ?? "{}";
  const lines = [
    `⏺ ${call.name}(${truncate_text(args_json, TOOL_ARGS_PREVIEW_CHARS)})`,
    `  ⎿ ${ok === true ? "ok" : "error"} (${truncate_text(result_content, TOOL_OUTPUT_PREVIEW_CHARS)})`,
  ];
  return { role: ok === true ? "tool" : "error", lines };
}

export function compress_notice_block(summary_chars: number): HistoryBlock {
  return { role: "meta", lines: [`· compressed (${summary_chars} chars)`] };
}
