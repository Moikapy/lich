/**
 * Best-effort context compression: replaces older conversation turns with a
 * terse LLM-generated summary while preserving system prompts and recent
 * messages verbatim. Compression failures are logged, never fatal.
 */
import { safe_stringify } from "../util/json.js";
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

/** Floor/ceiling for summarizer input; default budget (100k) → 24k chars. */
const MIN_TRANSCRIPT_CHARS = 8000;
const MAX_TRANSCRIPT_CHARS = 96000;
const CHARS_PER_BUDGET_TOKEN = 0.24;
const MIN_PER_MESSAGE_CHARS = 256;

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

/** Scale summarizer transcript cap with the agent context budget. */
export function transcript_char_budget(budget_tokens: number): number {
  const scaled = Math.floor(Math.max(0, budget_tokens) * CHARS_PER_BUDGET_TOKEN);
  return Math.min(MAX_TRANSCRIPT_CHARS, Math.max(MIN_TRANSCRIPT_CHARS, scaled));
}

/** Keep head and tail so early goals and recent older turns both survive. */
export function truncate_head_tail(text: string, max_chars: number): string {
  if (max_chars <= 0) {
    return "";
  }
  if (text.length <= max_chars) {
    return text;
  }
  if (max_chars < 40) {
    return text.slice(0, max_chars);
  }
  const marker_budget = 28;
  const half = Math.floor((max_chars - marker_budget) / 2);
  const omitted = text.length - half * 2;
  return `${text.slice(0, half)}\n[...${omitted} chars...]\n${text.slice(-half)}`;
}

function format_history_line(message: Message): string {
  const rendered_calls =
    message.role === "assistant" && message.tool_calls !== undefined
      ? ` tool_calls=${safe_stringify(message.tool_calls)}`
      : "";
  return `[${message.role}] ${message.content}${rendered_calls}`;
}

function format_capped_transcript(older: readonly Message[], max_chars: number): string {
  if (older.length === 0) {
    return "";
  }
  const per_message = Math.max(MIN_PER_MESSAGE_CHARS, Math.floor(max_chars / older.length));
  const lines = older.map((message) => truncate_head_tail(format_history_line(message), per_message));
  const joined = lines.join("\n");
  if (joined.length <= max_chars) {
    return joined;
  }
  return truncate_head_tail(joined, max_chars);
}

function build_summary_request(
  older: readonly Message[],
  model_hint: string | undefined,
  budget_tokens: number,
): UserMessage {
  const max_chars = transcript_char_budget(budget_tokens);
  const transcript = format_capped_transcript(older, max_chars);
  const hint = model_hint === undefined ? "" : `\n(Continuing agent run as model: ${model_hint})`;
  return {
    role: "user",
    content:
      "Summarize the following earlier conversation so the agent can continue the task from the summary alone.\n\n" +
      transcript +
      hint,
  };
}

function log_compression_failure(error: unknown): void {
  if (error instanceof ProviderError) {
    logger.warn(`context compression failed kind=${error.kind} provider=${error.provider_name}`, error);
    return;
  }
  logger.warn("context compression failed", error);
}

/** Keep-recent cut that never starts on an orphan tool result. */
function split_keep_recent(
  non_system: readonly Message[],
  keep_recent: number,
): { recent: Message[]; older: Message[] } {
  let cut = Math.max(0, non_system.length - keep_recent);
  while (cut > 0 && non_system[cut]?.role === "tool") {
    cut -= 1;
  }
  return { recent: non_system.slice(cut), older: non_system.slice(0, cut) };
}

export async function compress_messages(
  deps: CompressDeps,
  messages: readonly Message[],
  params: CompressParams,
): Promise<CompressOutcome> {
  const system_messages = messages.filter((message) => message.role === "system");
  const non_system = messages.filter((message) => message.role !== "system");
  const keep_recent = Math.max(0, params.keep_recent);
  const { recent, older } = split_keep_recent(non_system, keep_recent);
  if (older.length === 0) {
    return { messages: [...messages], summary_chars: 0 };
  }
  try {
    const result = await deps.chat(
      [
        { role: "system", content: COMPRESSION_SYSTEM_PROMPT },
        build_summary_request(older, params.model_hint, params.budget_tokens),
      ],
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
