/**
 * Server-owned session bags for `lich serve`: one SessionHandle + history per id.
 * In-memory bags are capped (LRU): the oldest idle bag is evicted first.
 * `pin` holds a bag for an in-flight prompt so a create cannot drop it before
 * the turn writes its history back. The map may sit above the cap until those
 * pins release. Evicted transcripts stay on disk and can be resumed again.
 */
import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { SessionManager } from "../session/manager.js";
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
 * messages the bag stores (trailing users already dropped by
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
  /** Bumped by clear() so in-flight runs can detect a mid-run clear. */
  epoch: number;
}

export interface ServeSessionStore {
  create(params: SessionCreateParams): Promise<SessionCreateResult>;
  clear(params: SessionClearParams): SessionClearResult;
  list(): Promise<SessionListResult>;
  resume(params: SessionResumeParams): Promise<SessionResumeResult>;
  get(session_id: string): ServeSessionBag | undefined;
  /** Hold `session_id` against LRU eviction (one hold per in-flight submit). */
  pin(session_id: string): void;
  /** Release one hold from `pin`. Idle bags over the cap are evicted. */
  unpin(session_id: string): void;
  /** Drop every in-memory bag (transcripts on disk are untouched). */
  dispose(): void;
}

/** Default LRU cap for in-memory bags; `0` disables the cap. */
export const DEFAULT_SERVE_SESSION_LIMIT = 32;

export function create_serve_session_store(
  session_dir: string,
  max_bags: number = DEFAULT_SERVE_SESSION_LIMIT,
  /** Shared with prompt.submit so a resume waits out the turn writing this transcript. */
  turns?: SessionManager,
): ServeSessionStore {
  const bags = new Map<string, ServeSessionBag>();
  /** session_id → in-flight submits that must survive LRU eviction. */
  const pins = new Map<string, number>();

  /** Map#set re-inserts at the end, so the first key is the least recently used. */
  function touch(id: string): void {
    const bag = bags.get(id);
    if (bag !== undefined) {
      bags.delete(id);
      bags.set(id, bag);
    }
  }

  function is_pinned(id: string): boolean {
    return (pins.get(id) ?? 0) > 0;
  }

  /**
   * Drop oldest idle bags until `bags` fits the cap. `spare_id` is never
   * dropped: the bag just inserted, so `session.create` does not hand back an
   * id this same call evicted, or the bag whose turn just finished. The map
   * stays over the cap until a pin releases.
   */
  function evict_overflow(spare_id?: string): void {
    if (max_bags <= 0) {
      return;
    }
    while (bags.size > max_bags) {
      let oldest_idle: string | undefined;
      for (const candidate of bags.keys()) {
        if (is_pinned(candidate) === true || candidate === spare_id) {
          continue;
        }
        oldest_idle = candidate;
        break;
      }
      if (oldest_idle === undefined) {
        return;
      }
      bags.delete(oldest_idle);
      logger.info(`serve session bag evicted (LRU): ${oldest_idle}`);
    }
  }

  function put(id: string, bag: ServeSessionBag): void {
    bags.set(id, bag);
    evict_overflow(id);
  }

  /** Read `transcript` and fork it into a new bag. `transcript` is already resolved. */
  async function fork_resumed_transcript(transcript: string, source: string | undefined): Promise<SessionResumeResult> {
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
      // in-memory state; mark seeded so prompt.submit's recorder.seed
      // appends only the new turn.
      await write_fork_transcript(handle.path, messages);
      mark_session_seeded(handle);
    } catch (error) {
      throw client_error(error);
    }
    put(handle.id, { handle, source: source ?? "resume", history: [...messages], epoch: 0 });
    return {
      session_id: handle.id,
      message_count: messages.length,
      resumed_id: path.basename(transcript, ".jsonl"),
    };
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
      put(handle.id, { handle, source: params.source, history: [], epoch: 0 });
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
      // Same bag object is mutated in place, so writers compare epoch, not identity.
      bag.epoch += 1;
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
      // Keep the file resolved now (`latest` and prefixes included) and read it
      // only after an in-flight prompt.submit on that id has finished writing.
      const file_id = path.basename(transcript, ".jsonl");
      const fork = (): Promise<SessionResumeResult> => fork_resumed_transcript(transcript, params.source);
      return turns === undefined ? fork() : turns.enqueue(file_id, fork);
    },
    get: (session_id) => {
      touch(session_id);
      return bags.get(session_id);
    },
    pin: (session_id) => {
      pins.set(session_id, (pins.get(session_id) ?? 0) + 1);
    },
    unpin: (session_id) => {
      const next = (pins.get(session_id) ?? 0) - 1;
      if (next <= 0) {
        pins.delete(session_id);
      } else {
        pins.set(session_id, next);
      }
      // Spare the bag whose turn just finished: it is in active use, even if
      // it is the oldest idle bag while the others are still pinned.
      evict_overflow(session_id);
    },
    dispose: () => {
      bags.clear();
      pins.clear();
    },
  };
}