/** Local Chat transcript state helpers (session-scoped, not shared ServeRuntime). */
import type { HistoryBlock } from "./types";

/** Values applied when the serve session changes so prior transcript does not linger. */
export function cleared_chat_local_state(): {
  blocks: readonly HistoryBlock[];
  busy: false;
} {
  return { blocks: [], busy: false };
}
