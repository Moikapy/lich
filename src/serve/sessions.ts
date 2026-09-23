/**
 * Server-owned session bags for `lich serve`: one SessionHandle + history per id.
 * In-memory bags are capped (LRU): the oldest is evicted first. Evicted
 * transcripts stay on disk and can be resumed again.
 */
import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { Message } from "../providers/types.js";
import { logger } from "../util/log.js";
import { is_enoent } from "../util/fs.js";
import { safe_stringify } from "../util/json.js";
import { mark_session_seeded } from "../session/recorder.js";
import { list_session_files, resolve_session_path, SessionResolveError } from "../session/resolve.js";
import { open_session, read_session_messages, type SessionHandle } from "../session/store.js";
import type {
  SessionClearParams,
  SessionClearResult,
  SessionCreateParams,
  SessionCreateResult,
  SessionListResult,
  SessionResumeParams,
  SessionResumeResult,
} from "./protocol.js";

/** Thrown by store methods; `kind` maps to stable client-facing text. */
export type ServeSessionErrorKind = "not_found" | "ambiguous" | "unreadable" | "internal";

export class ServeSessionError extends Error {
  readonly kind: ServeSessionErrorKind;

  constructor(kind: ServeSessionErrorKind, message: string) {
    super(message);
    this.name = "ServeSessionError";
    this.kind = kind;
  }
}

/** Stable client-facing message per error kind (no paths or candidate lists). */
const CLIENT_MESSAGES: Record<ServeSessionErrorKind, string> = {
  not_found: "session not found",
  ambiguous: "ambiguous session id",
  unreadable: "session transcript unreadable",
  internal: "session operation failed",
};

/** Wrap a store failure: log details server-side, expose only the kind + stable text. */
function client_error(error: unknown): ServeSessionError {
  if (error instanceof ServeSessionError) {
    return error;
  }
  const kind: ServeSessionErrorKind = error instanceof SessionResolveError
    ? error.kind === "ambiguous" ? "ambiguous" : "not_found"
    : is_enoent(error) === true
      ? "not_found"
      : "internal";
  logger.warn("serve session operation failed", error);
  return new ServeSessionError(kind, CLIENT_MESSAGES[kind]);
}

/**
 * Eagerly create the transcript file so `session.list` sees a fresh id before
 * its first append. `ax` fails on collision instead of truncating a transcript.
 */
async function touch_transcript(file_path: string): Promise<void> {
  await writeFile(file_path, "", { flag: "ax" });
}

/**
 * Write the filtered resume history into a new fork transcript. Uses the same
 * messages the bag stores (trailing user already dropped by
 * `read_session_messages`) so the on-disk fork matches in-memory history —
 * a raw byte copy would reintroduce the dropped user and leave meta lines
 * that `recorder.seed` would then duplicate on top. `ax` fails on collision
 * instead of truncating an existing transcript.
 */
async function write_fork_transcript(
  target_path: string,
  messages: readonly Message[],
): Promise<void> {
  const ts = new Date().toISOString();
  const lines = messages.map((message) =>
    safe_stringify({ ts, kind: "message", message }),
  );
  const body = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  await writeFile(target_path, body, { flag: "ax" });
}

export interface ServeSessionBag {
  readonly handle: SessionHandle;
  readonly source: string;
  history: Message[];
}

export interface ServeSessionStore {
  create(params: SessionCreateParams): Promise<SessionCreateResult>;
  clear(params: SessionClearParams): SessionClearResult;
  list(): Promise<SessionListResult>;
  resume(params: SessionResumeParams): Promise<SessionResumeResult>;
  get(session_id: string): ServeSessionBag | undefined;
  /** Drop every in-memory bag (transcripts on disk are untouched). */
  dispose(): void;
}

/** Default LRU cap for in-memory bags; `0` disables the cap. */
export const DEFAULT_SERVE_SESSION_LIMIT = 32;

export function create_serve_session_store(
  session_dir: string,
  max_bags: number = DEFAULT_SERVE_SESSION_LIMIT,
): ServeSessionStore {
  const bags = new Map<string, ServeSessionBag>();

  /** Map#set re-inserts at the end, so the first key is the least recently used. */
  function touch(id: string): void {
    const bag = bags.get(id);
    if (bag !== undefined) {
      bags.delete(id);
      bags.set(id, bag);
    }
  }

  function put(id: string, bag: ServeSessionBag): void {
    bags.set(id, bag);
    if (max_bags > 0 && bags.size > max_bags) {
      const oldest = bags.keys().next().value;
      if (oldest !== undefined) {
        bags.delete(oldest);
        logger.info(`serve session bag evicted (LRU): ${oldest}`);
      }
    }
  }

  return {
    create: async (params) => {
      let handle: SessionHandle;
      try {
        handle = await open_session(session_dir, params.label);
        await touch_transcript(handle.path);
      } catch (error) {
        throw client_error(error);
      }
      put(handle.id, { handle, source: params.source, history: [] });
      return { session_id: handle.id };
    },
    clear: (params) => {
      const bag = bags.get(params.session_id);
      if (bag === undefined) {
        throw new ServeSessionError(
          "not_found",
          `${CLIENT_MESSAGES.not_found}: ${params.session_id}`,
        );
      }
      bag.history = [];
      touch(params.session_id);
      return { session_id: params.session_id };
    },
    list: async () => {
      try {
        const entries = await list_session_files(session_dir);
        return {
          sessions: entries.map((entry) => ({ id: entry.id, mtime_ms: entry.mtime_ms })),
        };
      } catch (error) {
        throw client_error(error);
      }
    },
    resume: async (params) => {
      let transcript: string;
      try {
        transcript = await resolve_session_path(session_dir, params.id);
      } catch (error) {
        throw client_error(error);
      }
      let messages: Message[];
      try {
        messages = await read_session_messages(transcript);
      } catch (error) {
        // File vanished between resolve and read → same as not found.
        if (is_enoent(error) === true) {
          throw new ServeSessionError("not_found", CLIENT_MESSAGES.not_found);
        }
        logger.warn("serve session transcript unreadable", error);
        throw new ServeSessionError("unreadable", CLIENT_MESSAGES.unreadable);
      }
      let handle: SessionHandle;
      try {
        handle = await open_session(session_dir, "resume");
        // Write the filtered bag history (not a raw copy) so the fork matches
        // in-memory state; mark seeded so #83 prompt.submit's recorder.seed
        // appends only the new turn.
        await write_fork_transcript(handle.path, messages);
        mark_session_seeded(handle);
      } catch (error) {
        throw client_error(error);
      }
      put(handle.id, { handle, source: params.source ?? "resume", history: [...messages] });
      return {
        session_id: handle.id,
        message_count: messages.length,
        resumed_id: path.basename(transcript, ".jsonl"),
      };
    },
    get: (session_id) => {
      touch(session_id);
      return bags.get(session_id);
    },
    dispose: () => {
      bags.clear();
    },
  };
}