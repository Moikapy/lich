/**
 * prompt.submit / prompt.abort for lich serve: one Agent, SessionHandle per bag,
 * serialized runs, AbortSignal cancel, AgentEvent → WS notify.
 */
import type { Agent, AgentRunResult } from "../agent/agent.js";
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
}

/**
 * Owns in-flight AbortControllers and a single run queue so AgentEvent fan-out
 * stays 1:1 with the submitting session_id (Agent.events is process-wide).
 */
export function create_serve_prompt_service(
  agent: Agent,
  sessions: ServeSessionStore,
): ServePromptService {
  const inflight = new Map<string, AbortController>();
  let run_tail: Promise<unknown> = Promise.resolve();

  return {
    submit: async (params, notify) => {
      const bag = sessions.get(params.session_id);
      if (bag === undefined) {
        throw new Error(`session not found: ${params.session_id}`);
      }

      const previous = run_tail;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      run_tail = previous.then(() => gate).catch(() => gate);
      await previous.catch(() => undefined);

      const controller = new AbortController();
      inflight.set(params.session_id, controller);
      const stop = agent.events.on((event) => {
        notify({
          jsonrpc: "2.0",
          method: SERVE_NOTIFICATION_EVENT,
          params: { session_id: params.session_id, event },
        });
      });
      try {
        const result = await agent.run({
          input: params.text,
          history: bag.history,
          signal: controller.signal,
          session: bag.handle,
          label: bag.source,
        });
        bag.history = [...result.messages];
        return map_submit_result(params.session_id, result);
      } finally {
        stop();
        if (inflight.get(params.session_id) === controller) {
          inflight.delete(params.session_id);
        }
        release();
      }
    },
    abort: (params) => {
      const controller = inflight.get(params.session_id);
      if (controller === undefined) {
        return { session_id: params.session_id, aborted: false };
      }
      controller.abort();
      return { session_id: params.session_id, aborted: true };
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
