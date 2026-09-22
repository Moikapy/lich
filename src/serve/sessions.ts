/**
 * Server-owned session bags for `lich serve`: one SessionHandle + history per id.
 */
import type { Message } from "../providers/types.js";
import { list_session_files, resolve_session_path } from "../session/resolve.js";
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
}

export function create_serve_session_store(session_dir: string): ServeSessionStore {
  const bags = new Map<string, ServeSessionBag>();

  return {
    create: async (params) => {
      const handle = await open_session(session_dir, params.label);
      bags.set(handle.id, { handle, source: params.source, history: [] });
      return { session_id: handle.id };
    },
    clear: (params) => {
      const bag = bags.get(params.session_id);
      if (bag === undefined) {
        throw new Error(`session not found: ${params.session_id}`);
      }
      bag.history = [];
      return { session_id: params.session_id };
    },
    list: async () => {
      const entries = await list_session_files(session_dir);
      return {
        sessions: entries.map((entry) => ({ id: entry.id, mtime_ms: entry.mtime_ms })),
      };
    },
    resume: async (params) => {
      const transcript = await resolve_session_path(session_dir, params.id);
      const messages = await read_session_messages(transcript);
      const handle = await open_session(session_dir, "resume");
      bags.set(handle.id, { handle, source: "resume", history: [...messages] });
      return { session_id: handle.id, message_count: messages.length };
    },
    get: (session_id) => bags.get(session_id),
  };
}
