/** Post-submit transcript notices (final reply / budget). */
import { budget_notice_block, reply_block } from "./transcript";
import type { HistoryBlock } from "./types";

export function submit_notice_blocks(result: {
  reply: string | undefined;
  stopped_reason: "final" | "budget" | "aborted";
}): HistoryBlock[] {
  const blocks: HistoryBlock[] = [];
  if (result.stopped_reason === "budget") {
    blocks.push(budget_notice_block());
  }
  if (result.reply !== undefined && result.reply.length > 0) {
    blocks.push(reply_block(result.reply));
  }
  return blocks;
}
