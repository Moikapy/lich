/** Map one wire event to optional transcript blocks (tool rows, notices). */
import { compress_notice_block, error_notice_block, tool_result_block } from "./transcript";
import type { HistoryBlock, WireAgentEvent } from "./types";

export function event_blocks(event: WireAgentEvent): readonly HistoryBlock[] {
  if (event.type === "tool_call_end") {
    if (event.cancelled === true) {
      return [];
    }
    return [tool_result_block(event.call, event.result.ok === true, event.result.output)];
  }
  if (event.type === "compress_end") {
    return [compress_notice_block(event.summary_chars)];
  }
  if (event.type === "error") {
    const message =
      event.error instanceof Error
        ? event.error.message
        : typeof event.error === "string"
          ? event.error
          : String(event.error);
    return [error_notice_block(message)];
  }
  return [];
}
