/**
 * Typed event emitter for the agent loop.
 *
 * Loop code emits AgentEventBody (no envelope). Agent.run wraps each body into
 * an AgentEvent with run/session/seq/ts before fan-out on Agent.events / on_event.
 * Handlers may unsubscribe mid-emit; a throwing handler never breaks the loop.
 */
import { ProviderError } from "../providers/types.js";
import type { AssistantMessage, ChatResult, ToolCall, Usage } from "../providers/types.js";
import type { ToolResult } from "../tools/types.js";
import { logger } from "../util/log.js";

/** JSON-safe error payload on the wire and in AgentEvent.error. */
export type AgentErrorPayload = { kind: string; message: string };

export type RunStoppedReason = "final" | "budget" | "aborted";

export interface AgentEventBodies {
  turn_start: { turn: number };
  llm_start: { turn: number };
  llm_end: { turn: number; result: ChatResult };
  tool_call_start: { turn: number; call: ToolCall };
  tool_call_end: { turn: number; call: ToolCall; result: ToolResult; cancelled?: boolean };
  compress_start: { estimated_tokens: number };
  /** Summarizer usage is optional so the recorder never treats it as an assistant turn. */
  compress_end: { summary_chars: number; usage?: Usage };
  turn_end: { turn: number };
  final: { message: AssistantMessage; result: ChatResult };
  budget_exhausted: { turns_used: number };
  error: { error: AgentErrorPayload };
  /** No payload fields; marker event for the start of Agent.run. */
  run_start: { marker?: undefined };
  run_end: { stopped_reason: RunStoppedReason; turns_used: number };
}

export type AgentEventBody = {
  [K in keyof AgentEventBodies]: { type: K } & AgentEventBodies[K];
}[keyof AgentEventBodies];

/** Per-run envelope fields attached by Agent.run. */
export type EventEnvelope = {
  run_id: string;
  session_id: string;
  seq: number;
  ts: number;
};

/** Public / wire shape: body plus envelope. */
export type AgentEvent = AgentEventBody & EventEnvelope;

/** @deprecated Prefer AgentEventBodies; kept for re-export compatibility. */
export type AgentEvents = AgentEventBodies;

export type AgentEventHandler = (event: AgentEvent) => void;
export type AgentEventBodyHandler = (event: AgentEventBody) => void;

/** Normalize unknown throwables into a JSON-safe error payload. */
export function to_agent_error_payload(error: unknown): AgentErrorPayload {
  if (error instanceof ProviderError) {
    return { kind: error.kind, message: error.message };
  }
  if (error instanceof Error) {
    const kind = error.name.length > 0 ? error.name : "Error";
    return { kind, message: error.message };
  }
  return { kind: "Error", message: String(error) };
}

function emit_to_handlers<T>(handlers: ReadonlySet<(event: T) => void>, event: T): void {
  for (const handler of [...handlers]) {
    try {
      handler(event);
    } catch (handler_error) {
      logger.error("agent event handler threw", handler_error);
    }
  }
}

/** Body-only emitter used by the conversation loop. */
export class AgentEmitter {
  private readonly handlers: Set<AgentEventBodyHandler> = new Set();

  on(handler: AgentEventBodyHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(event: AgentEventBody): void {
    emit_to_handlers(this.handlers, event);
  }

  clear(): void {
    this.handlers.clear();
  }
}

/** Enveloped emitter exposed on Agent.events. */
export class EnvelopedAgentEmitter {
  private readonly handlers: Set<AgentEventHandler> = new Set();

  on(handler: AgentEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(event: AgentEvent): void {
    emit_to_handlers(this.handlers, event);
  }

  clear(): void {
    this.handlers.clear();
  }
}
