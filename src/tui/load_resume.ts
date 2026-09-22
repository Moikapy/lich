/**
 * Resolve and read a session transcript for the TUI `/resume` command.
 */
import path from "node:path";
import type { Message } from "../providers/types.js";
import { resolve_session_path } from "../session/resolve.js";
import { read_session_messages } from "../session/store.js";
import type { ThemeSpec } from "../util/lore.js";
import { error_notice_block, resume_session_view, type HistoryBlock } from "./state.js";

export type LoadResumeResult =
  | { ok: true; id: string; messages: readonly Message[]; blocks: readonly HistoryBlock[]; banner_line: string }
  | { ok: false; block: HistoryBlock };

function run_error_text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Load a transcript for `/resume`; returns view state or an error notice. */
export async function load_resume_view(
  session_dir: string,
  value: string,
  theme: ThemeSpec,
): Promise<LoadResumeResult> {
  try {
    const transcript = await resolve_session_path(session_dir, value);
    const messages = await read_session_messages(transcript);
    const id = path.basename(transcript, ".jsonl");
    const view = resume_session_view(id, messages, theme);
    return { ok: true, id, messages, blocks: view.blocks, banner_line: view.banner_line };
  } catch (error) {
    return { ok: false, block: error_notice_block(run_error_text(error)) };
  }
}
