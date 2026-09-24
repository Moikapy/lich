/**
 * Event-driven session transcript writer. Appends messages as the loop emits
 * them so a mid-run kill keeps every completed LLM/tool exchange on disk.
 */
import type { AgentEvent } from "../agent/events.js";
import { tool_message_from_result } from "../agent/loop.js";
import type { Message, Usage } from "../providers/types.js";
import { logger } from "../util/log.js";
import type { SessionHandle, SessionRecord } from "./store.js";

/** Handles that already received history seed for a shared TUI transcript. */
const seeded_handles = new WeakSet<SessionHandle>();

/**
 * Mark a handle as already seeded so a later `recorder.seed` (with `owned:
 * false`) appends only the new user turn. Serve uses this after writing a
 * filtered resume fork; the TUI marks via the first seed call itself.
 */
export function mark_session_seeded(handle: SessionHandle): void {
  seeded_handles.add(handle);
}

export interface RecorderSeed {
  input: string;
  history: readonly Message[];
  system_prompt: string | undefined;
  /** True when Agent opened this handle for a single run (not TUI-shared). */
  owned: boolean;
}

export interface SessionRecorder {
  readonly path: string;
  on_event(event: AgentEvent): void;
  seed(seed: RecorderSeed): Promise<void>;
  finish(stopped_reason: string, usage_total: Usage): Promise<void>;
  flush(): Promise<void>;
}

function record_ts(): string {
  return new Date().toISOString();
}

function warn_append(error: unknown): void {
  logger.warn("session persistence failed; continuing without transcript", error);
}

export function create_session_recorder(handle: SessionHandle): SessionRecorder {
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (write: () => Promise<void>): void => {
    chain = chain.then(write).catch(warn_append);
  };

  const append = (record: SessionRecord): Promise<void> => handle.append(record);

  const append_message = (message: Message): Promise<void> =>
    append({ ts: record_ts(), kind: "message", message });

  const append_meta = (meta: Record<string, unknown>): Promise<void> =>
    append({ ts: record_ts(), kind: "meta", meta });

  const on_event = (event: AgentEvent): void => {
    if (event.type === "llm_end") {
      enqueue(() => append_message(event.result.message));
      return;
    }
    if (event.type === "tool_call_end") {
      enqueue(() => append_message(tool_message_from_result(event.call, event.result)));
      return;
    }
    if (event.type === "budget_exhausted") {
      enqueue(() => append_meta({ event: "budget_exhausted" }));
      return;
    }
    if (event.type === "compress_end") {
      enqueue(() => append_meta({ event: "compress_end", summary_chars: event.summary_chars }));
    }
  };

  const seed = async (seed_opts: RecorderSeed): Promise<void> => {
    const history_size = seed_opts.history.length;
    await append_meta({
      event: "run_start",
      input_chars: seed_opts.input.length,
      history_size,
    }).catch(warn_append);

    const needs_history = seed_opts.owned || seeded_handles.has(handle) === false;
    if (needs_history) {
      seeded_handles.add(handle);
      const has_system = seed_opts.history.some((message) => message.role === "system");
      if (has_system === false && seed_opts.system_prompt !== undefined) {
        await append_message({ role: "system", content: seed_opts.system_prompt }).catch(warn_append);
      }
      for (const message of seed_opts.history) {
        await append_message(message).catch(warn_append);
      }
    }
    await append_message({ role: "user", content: seed_opts.input }).catch(warn_append);
  };

  const flush = (): Promise<void> => chain;

  const finish = async (stopped_reason: string, usage_total: Usage): Promise<void> => {
    await flush();
    await append_meta({
      event: "run_end",
      stopped_reason,
      usage: {
        prompt_tokens: usage_total.prompt_tokens,
        completion_tokens: usage_total.completion_tokens,
        total_tokens: usage_total.total_tokens,
      },
    }).catch(warn_append);
  };

  return { path: handle.path, on_event, seed, finish, flush };
}
