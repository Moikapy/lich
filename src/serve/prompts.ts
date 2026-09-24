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
  /** Abort every in-flight run and forget the controllers (server stop). */
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
  /** session_id → live AbortControllers (one running + any queued). */
  const inflight = new Map<string, Set<AbortController>>();
  let run_tail: Promise<unknown> = Promise.resolve();

  /** Add the controller to the session's set, creating the set on first use. */
  function register_controller(session_id: string, controller: AbortController): void {
    let controllers = inflight.get(session_id);
    if (controllers === undefined) {
      controllers = new Set<AbortController>();
      inflight.set(session_id, controllers);
    }
    controllers.add(controller);
  }

  /** Drop the controller; forget the session's set once nothing is in flight. */
  function unregister_controller(session_id: string, controller: AbortController): void {
    const controllers = inflight.get(session_id);
    if (controllers === undefined) {
      return;
    }
    controllers.delete(controller);
    if (controllers.size === 0) {
      inflight.delete(session_id);
    }
  }

  return {
    submit: async (params, notify) => {
      const bag_before = sessions.get(params.session_id);
      if (bag_before === undefined) {
        throw new Error(`session not found: ${params.session_id}`);
      }
      const epoch_before = bag_before.epoch;

      const previous = run_tail;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      run_tail = previous.then(() => gate).catch(() => gate);

      // Register before the queue wait so prompt.abort can cancel a queued run.
      const controller = new AbortController();
      register_controller(params.session_id, controller);
      await previous.catch(() => undefined);

      // Aborted while queued: release the gate without starting the run.
      if (controller.signal.aborted === true) {
        unregister_controller(params.session_id, controller);
        release();
        return {
          session_id: params.session_id,
          reply: undefined,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          session_path: undefined,
          turns_used: 0,
          stopped_reason: "aborted",
        };
      }

      const stop = agent.events.on((event) => {
        notify({
          jsonrpc: "2.0",
          method: SERVE_NOTIFICATION_EVENT,
          params: { session_id: params.session_id, event: wire_agent_event(event) },
        });
      });
      try {
        const result = await agent.run({
          input: params.text,
          history: bag_before.history,
          signal: controller.signal,
          session: bag_before.handle,
          label: bag_before.source,
        });
        // Write back only if clear() (or eviction) did not reset the bag mid-run.
        const bag_after = sessions.get(params.session_id);
        if (bag_after === bag_before && bag_after.epoch === epoch_before) {
          bag_after.history = [...result.messages];
        }
        return map_submit_result(params.session_id, result);
      } finally {
        stop();
        unregister_controller(params.session_id, controller);
        release();
      }
    },
    abort: (params) => {
      const controllers = inflight.get(params.session_id);
      if (controllers === undefined || controllers.size === 0) {
        return { session_id: params.session_id, aborted: false };
      }
      for (const controller of controllers) {
        controller.abort();
      }
      return { session_id: params.session_id, aborted: true };
    },
    abort_all: () => {
      for (const controllers of inflight.values()) {
        for (const controller of controllers) {
          controller.abort();
        }
      }
      inflight.clear();
    },
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

/** JSON-safe AgentEvent — raw Error becomes `{}` under JSON.stringify. */
function wire_agent_event(event: AgentEvent): AgentEvent {
  if (event.type !== "error") {
    return event;
  }
  return { type: "error", error: wire_error(event.error) };
}

function wire_error(error: unknown): unknown {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return error;
}
