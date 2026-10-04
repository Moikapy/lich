/**
 * The Think-Act-Observe agent loop.
 *
 * run_conversation drives a chat model, executes requested tools, feeds
 * results back, and compresses history when the context budget demands it.
 * It depends only on narrow structural interfaces (ChatFn, ToolRunner) so the
 * loop never imports provider routers or the tool executor directly.
 */
import { compress_messages, should_compress, split_keep_recent, type ChatFn } from "../context/compressor.js";
import { estimate_messages_tokens } from "../context/tokens.js";
import type {
  AssistantMessage,
  ChatOptions,
  ChatResult,
  Message,
  ToolCall,
  ToolDefinition,
  ToolMessage,
  Usage,
} from "../providers/types.js";
import type { BeforeLlmCallInfo, HookContext } from "../plugins/types.js";
import { ProviderError } from "../providers/types.js";
import type { ToolContext, ToolResult } from "../tools/types.js";
import { logger } from "../util/log.js";
import type { AgentEmitter } from "./events.js";
import { to_agent_error_payload } from "./events.js";

const DEFAULT_COMPRESS_THRESHOLD = 0.8;
const KEEP_RECENT_TURNS = 8;
/** After a failed or ineffective compress, skip this many subsequent turns. */
const COMPRESS_BACKOFF_TURNS = 3;

export interface ToolRunner {
  execute(name: string, args: Record<string, unknown>, context?: ToolContext): Promise<ToolResult>;
}

export interface LoopDeps {
  chat: ChatFn;
  /** Context-compression chat; falls back to `chat` when unset or failing. */
  compress_chat?: ChatFn;
  /** Plugin before_llm_call fan-out; returned notes apply to that one main-loop call. */
  before_llm_call?: (info: BeforeLlmCallInfo, ctx: HookContext) => Promise<string[]>;
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

interface CompressBackoff {
  skip_until_turn: number;
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

/** Format a tool result the same way the loop stores it on the tool message. */
export function format_tool_result_content(result: ToolResult): string {
  if (result.error !== undefined) {
    return JSON.stringify({ ok: false, output: result.output, error: result.error });
  }
  return result.output;
}

/** Rebuild the tool message that run_tool_calls would push for this call/result. */
export function tool_message_from_result(call: ToolCall, result: ToolResult): ToolMessage {
  const tool_message: ToolMessage = {
    role: "tool",
    tool_call_id: call.id,
    name: call.name,
    content: format_tool_result_content(result),
  };
  if (result.ok !== true) {
    tool_message.is_error = true;
  }
  return tool_message;
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
      const cancelled: ToolResult = { ok: false, output: "", error: "cancelled" };
      history.push(tool_message_from_result(call, cancelled));
      emitter?.emit({ type: "tool_call_end", turn, call, result: cancelled, cancelled: true });
      continue;
    }
    emitter?.emit({ type: "tool_call_start", turn, call });
    const result = await deps.tools.execute(call.name, call.args, deps.tool_context);
    history.push(tool_message_from_result(call, result));
    emitter?.emit({ type: "tool_call_end", turn, call, result });
  }
  return signal_aborted(signal) === true ? "aborted" : "continued";
}

/** History plus any before_llm_call notes as one trailing system message; history itself is untouched. */
async function messages_for_call(deps: LoopDeps, history: readonly Message[], turn: number): Promise<readonly Message[]> {
  if (deps.before_llm_call === undefined) {
    return history;
  }
  const ctx: HookContext = { work_dir: deps.tool_context?.work_dir ?? process.cwd() };
  // Deep copy: hooks must not reach live history objects or the session transcript.
  const notes = await deps.before_llm_call({ turn, messages: structuredClone(history) }, ctx);
  if (notes.length === 0) {
    return history;
  }
  return [...history, { role: "system", content: notes.join("\n\n") }];
}

async function call_chat(
  deps: LoopDeps,
  history: readonly Message[],
  params: LoopParams,
  emitter: AgentEmitter | undefined,
  turn: number,
): Promise<ChatResult> {
  try {
    const messages = await messages_for_call(deps, history, turn);
    return await deps.chat(messages, deps.definitions(), {
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
    emitter?.emit({ type: "error", error: to_agent_error_payload(error) });
    throw error;
  }
}

/**
 * Close final-turn tool calls with not-run results so the history stays valid
 * for resume; tool_call_end (as on the abort path) lets the recorder persist them.
 */
function skip_tool_calls(
  history: Message[],
  turn: number,
  calls: readonly ToolCall[],
  emitter: AgentEmitter | undefined,
): void {
  const skipped: ToolResult = { ok: false, output: "", error: "turn_budget_exhausted" };
  for (const call of calls) {
    history.push(tool_message_from_result(call, skipped));
    emitter?.emit({ type: "tool_call_end", turn, call, result: skipped, cancelled: true });
  }
}

function replace_history(history: Message[], next: readonly Message[]): void {
  history.length = 0;
  for (const message of next) {
    history.push(message);
  }
}

/** True when the compressor's kept-recent window alone still exceeds budget. */
function kept_tail_over_budget(
  history: readonly Message[],
  budget_tokens: number,
  threshold: number,
): boolean {
  const system_messages = history.filter((message) => message.role === "system");
  const non_system = history.filter((message) => message.role !== "system");
  const { recent } = split_keep_recent(non_system, KEEP_RECENT_TURNS);
  return should_compress([...system_messages, ...recent], budget_tokens, threshold);
}

function schedule_compress_backoff(backoff: CompressBackoff, turn: number): void {
  // turn < skip_until_turn skips COMPRESS_BACKOFF_TURNS subsequent turns.
  backoff.skip_until_turn = turn + COMPRESS_BACKOFF_TURNS + 1;
}

/** Compression role first; on a non-abort failure, retry on the main chat chain. */
async function compress_chat(
  deps: LoopDeps,
  messages: readonly Message[],
  tools: readonly ToolDefinition[],
  options?: ChatOptions,
): Promise<ChatResult> {
  if (deps.compress_chat === undefined) {
    return await deps.chat(messages, tools, options);
  }
  try {
    return await deps.compress_chat(messages, tools, options);
  } catch (error) {
    if (options?.signal?.aborted === true) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`compress chain failed (${message}); falling back to chat chain`);
    return await deps.chat(messages, tools, options);
  }
}

async function compress_if_needed(
  deps: LoopDeps,
  history: Message[],
  params: LoopParams,
  emitter: AgentEmitter | undefined,
  turn: number,
  backoff: CompressBackoff,
): Promise<void> {
  const budget_tokens = params.context_budget_tokens;
  if (budget_tokens === undefined) {
    return;
  }
  if (turn < backoff.skip_until_turn) {
    return;
  }
  const threshold = params.compress_threshold ?? DEFAULT_COMPRESS_THRESHOLD;
  if (!should_compress(history, budget_tokens, threshold)) {
    return;
  }
  const non_system_count = history.filter((message) => message.role !== "system").length;
  if (non_system_count <= KEEP_RECENT_TURNS) {
    schedule_compress_backoff(backoff, turn);
    return;
  }
  emitter?.emit({ type: "compress_start", estimated_tokens: estimate_messages_tokens(history) });
  let summarizer_usage: Usage | undefined;
  const counting_chat: ChatFn = async (messages, tools, options) => {
    const result = await compress_chat(deps, messages, tools, options);
    summarizer_usage = result.usage;
    return result;
  };
  const outcome = await compress_messages(
    { chat: counting_chat },
    history,
    { budget_tokens, keep_recent: KEEP_RECENT_TURNS, signal: params.signal },
  );
  replace_history(history, outcome.messages);
  emitter?.emit({
    type: "compress_end",
    summary_chars: outcome.summary_chars,
    usage: summarizer_usage,
  });
  if (outcome.summary_chars === 0) {
    schedule_compress_backoff(backoff, turn);
    return;
  }
  if (should_compress(history, budget_tokens, threshold) !== true) {
    return;
  }
  if (kept_tail_over_budget(history, budget_tokens, threshold) === true) {
    // Kept tail alone still overflows; retry after backoff so huge turns can age out.
    schedule_compress_backoff(backoff, turn);
    return;
  }
  // Full history (summary + recent) still high; retry after backoff so huge turns can age out.
  schedule_compress_backoff(backoff, turn);
}

function find_last_assistant(messages: readonly Message[]): AssistantMessage | undefined {
  return [...messages].reverse().find((message) => message.role === "assistant");
}

const PARTIAL_MESSAGES = Symbol("lich.partial_messages");
/** Copied examples read this non-enumerable field; they do not import the symbol. */
const PARTIAL_MESSAGES_KEY = "lich_partial_messages";

function signal_aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Attach in-memory history so a caller can keep turns that finished before chat threw. */
export function note_partial_messages(error: unknown, messages: readonly Message[]): unknown {
  if (typeof error === "object" && error !== null) {
    const copy = [...messages];
    Object.defineProperty(error, PARTIAL_MESSAGES, { value: copy, enumerable: false });
    Object.defineProperty(error, PARTIAL_MESSAGES_KEY, { value: copy, enumerable: false });
  }
  return error;
}

/** History captured when chat threw, if the loop annotated this error. */
export function partial_messages_of(error: unknown): Message[] | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const record = error as { [PARTIAL_MESSAGES]?: unknown; lich_partial_messages?: unknown };
  const value = record[PARTIAL_MESSAGES] ?? record.lich_partial_messages;
  return Array.isArray(value) ? (value as Message[]) : undefined;
}

/**
 * Messages to keep when a run throws after earlier turns finished.
 * Undefined when the error has no completed assistant or tool turn.
 */
export function history_after_run_error(error: unknown): Message[] | undefined {
  const partial = partial_messages_of(error);
  if (partial === undefined) {
    return undefined;
  }
  const kept = drop_trailing_users(partial);
  const progressed = kept.some((message) => message.role === "assistant" || message.role === "tool");
  return progressed ? kept : undefined;
}

function drop_trailing_users(messages: readonly Message[]): Message[] {
  const kept = [...messages];
  while (kept.at(-1)?.role === "user") {
    kept.pop();
  }
  return kept;
}

function aborted_outcome(history: Message[], turns_used: number): LoopOutcome {
  // Aborts are reported as run_end by Agent.run, not as type:"error".
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
  const compress_backoff: CompressBackoff = { skip_until_turn: 0 };
  for (const turn of turn_range(params.max_turns)) {
    if (signal_aborted(params.signal) === true) {
      return aborted_outcome(history, turn - 1);
    }
    emitter?.emit({ type: "turn_start", turn });
    await compress_if_needed(deps, history, params, emitter, turn, compress_backoff);
    emitter?.emit({ type: "llm_start", turn });
    let result: ChatResult;
    try {
      result = await call_chat(deps, history, params, emitter, turn);
    } catch (error) {
      if (signal_aborted(params.signal) === true) {
        return aborted_outcome(history, turn - 1);
      }
      throw note_partial_messages(error, history);
    }
    emitter?.emit({ type: "llm_end", turn, result });
    history.push(result.message);
    const calls = result.message.tool_calls ?? [];
    if (calls.length === 0) {
      emitter?.emit({ type: "final", message: result.message, result });
      emitter?.emit({ type: "turn_end", turn });
      return { messages: history, final: result.message, result, turns_used: turn, stopped_reason: "final" };
    }
    if (turn === params.max_turns) {
      // The model gets no turn to read results, so do not run side effects it cannot see.
      skip_tool_calls(history, turn, calls, emitter);
      break;
    }
    const tool_status = await run_tool_calls(deps, history, turn, calls, emitter, params.signal);
    if (tool_status === "aborted") {
      return aborted_outcome(history, turn);
    }
    emitter?.emit({ type: "turn_end", turn });
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
