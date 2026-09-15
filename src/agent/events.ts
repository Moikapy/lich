/**
 * Typed event emitter for the agent loop.
 *
 * Handlers receive a discriminated AgentEvent union. emit() iterates a
 * snapshot of the handler set so handlers may safely unsubscribe mid-emit,
 * and a throwing handler never breaks the loop.
 */
import type { AssistantMessage, ChatResult, ToolCall } from "../providers/types.js";
import type { ToolResult } from "../tools/types.js";
import { logger } from "../util/log.js";

export interface AgentEvents {
  turn_start: { turn: number };
  llm_start: { turn: number };
  llm_end: { turn: number; result: ChatResult };
  tool_call_start: { turn: number; call: ToolCall };
  tool_call_end: { turn: number; call: ToolCall; result: ToolResult };
  compress_start: { estimated_tokens: number };
  compress_end: { summary_chars: number };
  turn_end: { turn: number };
  final: { message: AssistantMessage; result: ChatResult };
  budget_exhausted: { turns_used: number };
  error: { error: unknown };
}

export type AgentEvent = { [K in keyof AgentEvents]: { type: K } & AgentEvents[K] }[keyof AgentEvents];

export type AgentEventHandler = (event: AgentEvent) => void;

export class AgentEmitter {
  private readonly handlers: Set<AgentEventHandler> = new Set();

  on(handler: AgentEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(event: AgentEvent): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(event);
      } catch (handler_error) {
        logger.error("agent event handler threw", handler_error);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}