/**
 * The Think-Act-Observe agent loop.
 *
 * run_conversation drives a chat model, executes requested tools, feeds
 * results back, and compresses history when the context budget demands it.
 * It depends only on narrow structural interfaces (ChatFn, ToolRunner) so the
 * loop never imports provider routers or the tool executor directly.
 */
import { compress_messages, should_compress, type ChatFn } from "../context/compressor.js";
import { estimate_messages_tokens } from "../context/tokens.js";
import type {
  AssistantMessage,
  ChatResult,
  Message,
  ToolCall,
  ToolDefinition,
  ToolMessage,
} from "../providers/types.js";
import { ProviderError } from "../providers/types.js";
import type { ToolContext, ToolResult } from "../tools/types.js";
import { logger } from "../util/log.js";
import type { AgentEmitter } from "./events.js";

const DEFAULT_COMPRESS_THRESHOLD = 0.8;
const KEEP_RECENT_TURNS = 8;

export interface ToolRunner {
  execute(name: string, args: Record<string, unknown>, context?: ToolContext): Promise<ToolResult>;
}

export interface LoopDeps {
  chat: ChatFn;
  tools: ToolRunner;
  definitions: () => ToolDefinition[];
  emitter?: AgentEmitter;
  /** Per-run ToolContext threaded to every tool execution (A6). */
  tool_context?: ToolContext;
}

export interface LoopParams {
  system_prompt?: string;
  max_turns: number;
  temperature?: number;
  max_tokens?: number;
  context_budget_tokens?: number;
  compress_threshold?: number;
  signal?: AbortSignal;
}

export interface LoopOutcome {
  messages: Message[];
  final: AssistantMessage | undefined;
  result: ChatResult | undefined;
  turns_used: number;
  stopped_reason: "final" | "budget" | "aborted";
}

function turn_range(max_turns: number): readonly number[] {
  return Array.from({ length: Math.max(0, max_turns) }, (_unused, index) => index + 1);
}

function seed_system_prompt(messages: readonly Message[], system_prompt: string | undefined): Message[] {
  const history = [...messages];
  if (system_prompt === undefined) {
    return history;
  }
  const system_index = history.findIndex((message) => message.role === "system");
  if (system_index === -1) {
    const seeded: Message = { role: "system", content: system_prompt };
    return [seeded, ...history];
  }
  const existing = history[system_index];
  if (existing !== undefined && existing.content === system_prompt) {
    return history;
  }
  const replaced: Message = { role: "system", content: system_prompt };
  return [...history.slice(0, system_index), replaced, ...history.slice(system_index + 1)];
}

function format_tool_result_content(result: ToolResult): string {
  if (result.error !== undefined) {
    return JSON.stringify({ ok: false, output: result.output, error: result.error });
  }
  return result.output;
}

async function run_tool_calls(
  deps: LoopDeps,
  history: Message[],
  turn: number,
  calls: readonly ToolCall[],
  emitter: AgentEmitter | undefined,
  signal: AbortSignal | undefined,
): Promise<"continued" | "aborted"> {
  for (const call of calls) {
    if (signal_aborted(signal) === true) {
      history.push(cancelled_tool_message(call));
      continue;
    }
    emitter?.emit({ type: "tool_call_start", turn, call });
    const result = await deps.tools.execute(call.name, call.args, deps.tool_context);
    const tool_message: ToolMessage = {
      role: "tool",
      tool_call_id: call.id,
      name: call.name,
      content: format_tool_result_content(result),
    };
    if (result.ok !== true) {
      tool_message.is_error = true;
    }
    history.push(tool_message);
    emitter?.emit({ type: "tool_call_end", turn, call, result });
  }
  return signal_aborted(signal) === true ? "aborted" : "continued";
}

function cancelled_tool_message(call: ToolCall): ToolMessage {
  return {
    role: "tool",
    tool_call_id: call.id,
    name: call.name,
    content: format_tool_result_content({ ok: false, output: "", error: "cancelled" }),
    is_error: true,
  };
}

async function call_chat(
  deps: LoopDeps,
  history: readonly Message[],
  params: LoopParams,
  emitter: AgentEmitter | undefined,
): Promise<ChatResult> {
  try {
    return await deps.chat(history, deps.definitions(), {
      temperature: params.temperature,
      max_tokens: params.max_tokens,
      signal: params.signal,
    });
  } catch (error) {
    if (signal_aborted(params.signal) === true) {
      throw error;
    }
    if (error instanceof ProviderError) {
      logger.error(`provider error kind=${error.kind} provider=${error.provider_name}`, error);
    } else {
      logger.error("agent chat call failed", error);
    }
    emitter?.emit({ type: "error", error });
    throw error;
  }
}

async function compress_if_needed(
  deps: LoopDeps,
  history: Message[],
  params: LoopParams,
  emitter: AgentEmitter | undefined,
): Promise<void> {
  const budget_tokens = params.context_budget_tokens;
  if (budget_tokens === undefined) {
    return;
  }
  const threshold = params.compress_threshold ?? DEFAULT_COMPRESS_THRESHOLD;
  if (!should_compress(history, budget_tokens, threshold)) {
    return;
  }
  const non_system_count = history.filter((message) => message.role !== "system").length;
  if (non_system_count <= KEEP_RECENT_TURNS) {
    return;
  }
  emitter?.emit({ type: "compress_start", estimated_tokens: estimate_messages_tokens(history) });
  const outcome = await compress_messages(
    { chat: deps.chat },
    history,
    { budget_tokens, keep_recent: KEEP_RECENT_TURNS, signal: params.signal },
  );
  history.length = 0;
  for (const message of outcome.messages) {
    history.push(message);
  }
  emitter?.emit({ type: "compress_end", summary_chars: outcome.summary_chars });
}

function find_last_assistant(messages: readonly Message[]): AssistantMessage | undefined {
  return [...messages].reverse().find((message) => message.role === "assistant");
}

function signal_aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function aborted_outcome(history: Message[], turns_used: number, emitter: AgentEmitter | undefined): LoopOutcome {
  emitter?.emit({ type: "error", error: new DOMException("agent loop aborted", "AbortError") });
  return {
    messages: history,
    final: find_last_assistant(history),
    result: undefined,
    turns_used,
    stopped_reason: "aborted",
  };
}

export async function run_conversation(
  deps: LoopDeps,
  messages: readonly Message[],
  params: LoopParams,
): Promise<LoopOutcome> {
  const history = seed_system_prompt(messages, params.system_prompt);
  const emitter = deps.emitter;
  for (const turn of turn_range(params.max_turns)) {
    if (signal_aborted(params.signal) === true) {
      return aborted_outcome(history, turn - 1, emitter);
    }
    emitter?.emit({ type: "turn_start", turn });
    await compress_if_needed(deps, history, params, emitter);
    emitter?.emit({ type: "llm_start", turn });
    let result: ChatResult;
    try {
      result = await call_chat(deps, history, params, emitter);
    } catch (error) {
      if (signal_aborted(params.signal) === true) {
        return aborted_outcome(history, turn - 1, emitter);
      }
      throw error;
    }
    emitter?.emit({ type: "llm_end", turn, result });
    history.push(result.message);
    const calls = result.message.tool_calls ?? [];
    if (calls.length === 0) {
      emitter?.emit({ type: "final", message: result.message, result });
      emitter?.emit({ type: "turn_end", turn });
      return { messages: history, final: result.message, result, turns_used: turn, stopped_reason: "final" };
    }
    const tool_status = await run_tool_calls(deps, history, turn, calls, emitter, params.signal);
    if (tool_status === "aborted") {
      return aborted_outcome(history, turn, emitter);
    }
  }
  emitter?.emit({ type: "budget_exhausted", turns_used: params.max_turns });
  emitter?.emit({ type: "turn_end", turn: params.max_turns });
  return {
    messages: history,
    final: find_last_assistant(history),
    result: undefined,
    turns_used: params.max_turns,
    stopped_reason: "budget",
  };
}