import type { JsonSchemaObject } from "../util/json_schema.js";

export type Role = "system" | "user" | "assistant" | "tool";

export type FinishReason = "stop" | "tool_calls" | "length" | "error" | "unknown";

export type ProviderErrorKind =
  | "rate_limit"
  | "network"
  | "auth"
  | "overflow"
  | "bad_request"
  | "unknown";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  tool_calls?: ToolCall[];
  /**
   * Opaque provider content blocks preserved for round-trip (e.g. Anthropic
   * thinking / redacted_thinking). When present, Anthropic replays these
   * instead of reconstructing text + tool_use from content/tool_calls.
   */
  provider_content?: readonly Record<string, unknown>[];
}

export interface ToolMessage {
  role: "tool";
  tool_call_id: string;
  name: string;
  content: string;
  is_error?: boolean;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatResult {
  message: AssistantMessage;
  usage: Usage;
  finish_reason: FinishReason;
  model: string;
  provider_name: string;
}

export interface ChatOptions {
  temperature?: number;
  max_tokens?: number;
  signal?: AbortSignal;
  /** Ollama-only: request thinking mode for this call. */
  think?: boolean;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  chat(
    messages: readonly Message[],
    tools: readonly ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatResult>;
}

export interface ProviderConfig {
  kind: "openai_compat" | "anthropic" | "ollama";
  name: string;
  model: string;
  base_url?: string;
  api_key?: string;
  api_key_env?: string;
  timeout_ms?: number;
  /** Anthropic-only: forward ChatOptions.temperature (default: omit). */
  send_temperature?: boolean;
  /** Ollama-only: request thinking mode (adds think:true to /api/chat). */
  think?: boolean;
  /** Ollama-only: how long the model stays loaded (e.g. "10m"). */
  keep_alive?: string;
  /** Ollama-only: context window size sent as options.num_ctx. */
  num_ctx?: number;
  /** Injectable fetch, mainly for tests. Defaults to global fetch. */
  fetch_fn?: typeof fetch;
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider_name: string;
  readonly status?: number;
  readonly retry_after_ms?: number;

  constructor(params: {
    kind: ProviderErrorKind;
    provider_name: string;
    message: string;
    status?: number;
    retry_after_ms?: number;
    cause?: unknown;
  }) {
    super(params.message);
    this.name = "ProviderError";
    this.kind = params.kind;
    this.provider_name = params.provider_name;
    this.status = params.status;
    this.retry_after_ms = params.retry_after_ms;
    if (params.cause !== undefined) {
      this.cause = params.cause;
    }
  }
}