/**
 * prompt.submit / prompt.abort for lich serve: one Agent, SessionHandle per bag,
 * serialized runs, AbortSignal cancel, AgentEvent → WS notify.
 */
import type { Agent, AgentRunResult } from "../agent/agent.js";
import type { AgentEvent } from "../agent/events.js";
import type {
  PromptAbortParams,
  PromptAbortResult,
  PromptSubmitParams,
  PromptSubmitResult,
  ServeEventNotification,
} from "./protocol.js";
import { SERVE_NOTIFICATION_EVENT } from "./protocol.js";
import type { ServeSessionStore } from "./sessions.js";

export type ServeEventNotify = (notification: ServeEventNotification) => void;

export interface ServePromptService {
  submit(params: PromptSubmitParams, notify: ServeEventNotify): Promise<PromptSubmitResult>;
  abort(params: PromptAbortParams): PromptAbortResult;
  /** Abort every queued or running submit (used on serve stop). */
  abort_all(): void;
}

/**
 * Owns in-flight AbortControllers and a single run queue so AgentEvent fan-out
 * stays 1:1 with the submitting session_id (Agent.events is process-wide).
 */
export function create_serve_prompt_service(
  agent: Agent,
  sessions: ServeSessionStore,
): ServePromptService {
  const inflight = new Map<string, Set<AbortController>>();
  let run_tail: Promise<unknown> = Promise.resolve();

  return {
    submit: async (params, notify) => {
      const bag = sessions.get(params.session_id);
      if (bag === undefined) {
        throw new Error(`session not found: ${params.session_id}`);
      }

      const controller = new AbortController();
      register_inflight(inflight, params.session_id, controller);

      const previous = run_tail;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      run_tail = previous.then(() => gate).catch(() => gate);

      try {
        await previous.catch(() => undefined);

        if (controller.signal.aborted) {
          return aborted_submit_result(params.session_id);
        }

        const stop = agent.events.on((event) => {
          notify({
            jsonrpc: "2.0",
            method: SERVE_NOTIFICATION_EVENT,
            params: { session_id: params.session_id, event: wire_event(event) },
          });
        });
        try {
          const seed = bag.history;
          const result = await agent.run({
            input: params.text,
            history: seed,
            signal: controller.signal,
            session: bag.handle,
            label: bag.source,
          });
          // Re-read after the run: LRU may have evicted this id, and
          // session.clear may have replaced history — skip orphan writeback.
          const live = sessions.get(params.session_id);
          if (live !== undefined && live.history === seed) {
            live.history = [...result.messages];
          }
          return map_submit_result(params.session_id, result);
        } finally {
          stop();
        }
      } finally {
        unregister_inflight(inflight, params.session_id, controller);
        release();
      }
    },
    abort: (params) => {
      const set = inflight.get(params.session_id);
      if (set === undefined || set.size === 0) {
        return { session_id: params.session_id, aborted: false };
      }
      for (const controller of set) {
        controller.abort();
      }
      return { session_id: params.session_id, aborted: true };
    },
    abort_all: () => {
      for (const set of inflight.values()) {
        for (const controller of set) {
          controller.abort();
        }
      }
    },
  };
}

function register_inflight(
  inflight: Map<string, Set<AbortController>>,
  session_id: string,
  controller: AbortController,
): void {
  let set = inflight.get(session_id);
  if (set === undefined) {
    set = new Set();
    inflight.set(session_id, set);
  }
  set.add(controller);
}

function unregister_inflight(
  inflight: Map<string, Set<AbortController>>,
  session_id: string,
  controller: AbortController,
): void {
  const set = inflight.get(session_id);
  if (set === undefined) {
    return;
  }
  set.delete(controller);
  if (set.size === 0) {
    inflight.delete(session_id);
  }
}

/** JSON-safe AgentEvent: Error/DOMException become { name, message }. */
function wire_event(event: AgentEvent): AgentEvent {
  if (event.type !== "error") {
    return event;
  }
  return { type: "error", error: serialize_error(event.error) };
}

function serialize_error(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}

function aborted_submit_result(session_id: string): PromptSubmitResult {
  return {
    session_id,
    reply: undefined,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    session_path: undefined,
    turns_used: 0,
    stopped_reason: "aborted",
  };
}

function map_submit_result(session_id: string, result: AgentRunResult): PromptSubmitResult {
  return {
    session_id,
    reply: result.outcome.final?.content,
    usage: result.usage_total,
    session_path: result.session_path,
    turns_used: result.outcome.turns_used,
    stopped_reason: result.outcome.stopped_reason,
  };
}
