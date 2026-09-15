/**
 * Best-effort context compression: replaces older conversation turns with a
 * terse LLM-generated summary while preserving system prompts and recent
 * messages verbatim. Compression failures are logged, never fatal.
 */
import { safe_stringify, truncate_text } from "../util/json.js";
import { logger } from "../util/log.js";
import type {
  ChatOptions,
  ChatResult,
  Message,
  ToolDefinition,
  UserMessage,
} from "../providers/types.js";
import { ProviderError } from "../providers/types.js";
import { estimate_messages_tokens } from "./tokens.js";

export const COMPRESSION_SYSTEM_PROMPT =
  "You compress agent conversation history into terse factual summaries. Preserve: goals, decisions, file paths, commands run, errors, open questions. Output plain text only.";

const MAX_TRANSCRIPT_CHARS = 24000;

export interface ChatFn {
  (messages: readonly Message[], tools: readonly ToolDefinition[], options?: ChatOptions): Promise<ChatResult>;
}

export interface CompressDeps {
  chat: ChatFn;
}

export interface CompressParams {
  budget_tokens: number;
  keep_recent: number;
  signal?: AbortSignal;
  model_hint?: string;
}

export interface CompressOutcome {
  messages: Message[];
  summary_chars: number;
}

export function should_compress(messages: readonly Message[], budget_tokens: number, threshold: number): boolean {
  return estimate_messages_tokens(messages) >= budget_tokens * threshold;
}

function format_history_line(message: Message): string {
  const rendered_calls =
    message.role === "assistant" && message.tool_calls !== undefined
      ? ` tool_calls=${safe_stringify(message.tool_calls)}`
      : "";
  return `[${message.role}] ${message.content}${rendered_calls}`;
}

function build_summary_request(older: readonly Message[], model_hint: string | undefined): UserMessage {
  const transcript = older.map((message) => format_history_line(message)).join("\n");
  const hint = model_hint === undefined ? "" : `\n(Continuing agent run as model: ${model_hint})`;
  return {
    role: "user",
    content:
      "Summarize the following earlier conversation so the agent can continue the task from the summary alone.\n\n" +
      truncate_text(transcript, MAX_TRANSCRIPT_CHARS),
  };
}

function log_compression_failure(error: unknown): void {
  if (error instanceof ProviderError) {
    logger.warn(`context compression failed kind=${error.kind} provider=${error.provider_name}`, error);
    return;
  }
  logger.warn("context compression failed", error);
}

export async function compress_messages(
  deps: CompressDeps,
  messages: readonly Message[],
  params: CompressParams,
): Promise<CompressOutcome> {
  const system_messages = messages.filter((message) => message.role === "system");
  const non_system = messages.filter((message) => message.role !== "system");
  const keep_recent = Math.max(0, params.keep_recent);
  const recent = non_system.slice(-keep_recent);
  const older = non_system.slice(0, Math.max(0, non_system.length - recent.length));
  if (older.length === 0) {
    return { messages: [...messages], summary_chars: 0 };
  }
  try {
    const result = await deps.chat(
      [{ role: "system", content: COMPRESSION_SYSTEM_PROMPT }, build_summary_request(older, params.model_hint)],
      [],
      { signal: params.signal },
    );
    const summary = result.message.content;
    const summary_message: UserMessage = {
      role: "user",
      content: `[context summary of earlier turns]\n${summary}\n[end summary]`,
    };
    return { messages: [...system_messages, summary_message, ...recent], summary_chars: summary.length };
  } catch (error) {
    log_compression_failure(error);
    return { messages: [...messages], summary_chars: 0 };
  }
}