/**
 * Resolve and read a session transcript for the TUI `/resume` command.
 */
import path from "node:path";
import type { Message } from "../providers/types.js";
import { resolve_session_path } from "../session/resolve.js";
import { open_session, read_session_messages, type SessionHandle } from "../session/store.js";
import { is_enoent } from "../util/fs.js";
import { logger } from "../util/log.js";
import type { ThemeSpec } from "../util/lore.js";
import { error_notice_block, resume_session_view, type HistoryBlock } from "./state.js";

export type LoadResumeResult =
  | { ok: true; id: string; messages: readonly Message[]; blocks: readonly HistoryBlock[]; banner_line: string }
  | { ok: false; block: HistoryBlock };

function run_error_text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read the transcript or map a vanished file to the same text serve uses. */
export async function read_transcript_or_not_found(file_path: string): Promise<Message[]> {
  try {
    return await read_session_messages(file_path);
  } catch (error) {
    if (is_enoent(error) === true) {
      throw new Error("session not found (transcript deleted)");
    }
    throw error;
  }
}

/**
 * New transcript for turns after an in-TUI `/resume`.
 * The launch handle is seeded on the first message, and a seeded handle's
 * next `recorder.seed` appends only the new user line. Reusing it would
 * leave the loaded history out of the file the next turn writes.
 */
export async function open_resume_continuation(session_dir: string): Promise<SessionHandle | undefined> {
  try {
    return await open_session(session_dir, "tui");
  } catch (error) {
    logger.warn("session persistence failed; continuing without transcript", error);
    return undefined;
  }
}

/** Load a transcript for `/resume`; returns view state or an error notice. */
export async function load_resume_view(
  session_dir: string,
  value: string,
  theme: ThemeSpec,
): Promise<LoadResumeResult> {
  try {
    const transcript = await resolve_session_path(session_dir, value);
    const messages = await read_transcript_or_not_found(transcript);
    const id = path.basename(transcript, ".jsonl");
    const view = resume_session_view(id, messages, theme);
    return { ok: true, id, messages, blocks: view.blocks, banner_line: view.banner_line };
  } catch (error) {
    return { ok: false, block: error_notice_block(run_error_text(error)) };
  }
}
