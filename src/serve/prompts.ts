/**
 * prompt.submit / prompt.abort for lich serve: one Agent, SessionHandle per bag,
 * per-session run queue, AbortSignal cancel, enveloped AgentEvent → WS notify.
 */
import type { Agent, AgentRunResult } from "../agent/agent.js";
import type { AgentEvent } from "../agent/events.js";
import { history_after_run_error } from "../agent/loop.js";
import { create_session_manager } from "../session/manager.js";
import type {
  PromptAbortParams,
  PromptAbortResult,
  PromptSubmitParams,
  PromptSubmitResult,
  ServeEventNotification,
} from "./protocol.js";
import { SERVE_NOTIFICATION_EVENT } from "./protocol.js";
import type { ServeSessionBag, ServeSessionStore } from "./sessions.js";

export type ServeEventNotify = (notification: ServeEventNotification) => void;

export interface ServePromptService {
  submit(params: PromptSubmitParams, notify: ServeEventNotify): Promise<PromptSubmitResult>;
  abort(params: PromptAbortParams): PromptAbortResult;
  /** Abort every in-flight run and forget the controllers (server stop). */
  abort_all(): void;
}

/**
 * Owns in-flight AbortControllers and a per-session run queue so concurrent
 * sessions do not serialize on each other. Events are scoped via Agent on_event.
 */
export function create_serve_prompt_service(
  agent: Agent,
  sessions: ServeSessionStore,
): ServePromptService {
  /** session_id → live AbortControllers (one running + any queued). */
  const inflight = new Map<string, Set<AbortController>>();
  const runs = create_session_manager();

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
    submit: (params, notify) => {
      const bag_before = sessions.get(params.session_id);
      if (bag_before === undefined) {
        throw new Error(`session not found: ${params.session_id}`);
      }
      const epoch_before = bag_before.epoch;

      // Register before the queue wait so prompt.abort can cancel a queued run.
      const controller = new AbortController();
      register_controller(params.session_id, controller);

      return runs.enqueue(params.session_id, async () => {
        // Aborted while queued: return without starting the run.
        if (controller.signal.aborted === true) {
          unregister_controller(params.session_id, controller);
          return {
            session_id: params.session_id,
            reply: undefined,
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            session_path: undefined,
            turns_used: 0,
            stopped_reason: "aborted" as const,
          };
        }

        try {
          const result = await agent.run({
            input: params.text,
            history: bag_before.history,
            signal: controller.signal,
            session: bag_before.handle,
            label: bag_before.source,
            session_id: params.session_id,
            on_event: (event) => {
              notify({
                jsonrpc: "2.0",
                method: SERVE_NOTIFICATION_EVENT,
                params: { session_id: params.session_id, event: wire_agent_event(event) },
              });
            },
          });
          // Write back only if clear() (or eviction) did not reset the bag mid-run.
          const bag_after = sessions.get(params.session_id);
          if (bag_after === bag_before && bag_after.epoch === epoch_before) {
            bag_after.history = [...result.messages];
          }
          return map_submit_result(params.session_id, result);
        } catch (error) {
          keep_completed_turns(sessions, params.session_id, bag_before, epoch_before, error);
          throw error;
        } finally {
          unregister_controller(params.session_id, controller);
        }
      });
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

/**
 * Chat threw after earlier turns in this run already finished. Keep those
 * turns unless clear() (or eviction) reset the bag mid-run; a trailing user
 * with no assistant reply is dropped, matching resume hygiene.
 */
function keep_completed_turns(
  sessions: ServeSessionStore,
  session_id: string,
  bag_before: ServeSessionBag,
  epoch_before: number,
  error: unknown,
): void {
  const kept = history_after_run_error(error);
  const bag_after = sessions.get(session_id);
  if (kept === undefined || bag_after !== bag_before || bag_after.epoch !== epoch_before) {
    return;
  }
  bag_after.history = kept;
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

/** Identity today: AgentEvent.error is already JSON-safe { kind, message }. */
function wire_agent_event(event: AgentEvent): AgentEvent {
  return event;
}
