import { safe_json_parse, safe_stringify, truncate_text } from "../util/json.js";
import { ProviderError } from "./types.js";
import type {
  AssistantMessage,
  ChatOptions,
  ChatResult,
  FinishReason,
  LLMProvider,
  Message,
  ProviderConfig,
  ProviderErrorKind,
  ToolCall,
  ToolDefinition,
  ToolMessage,
  Usage,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const WELL_KNOWN_HOST = "api.openai.com";
const WELL_KNOWN_KEY_ENV = "OPENAI_API_KEY";
const MAX_ERROR_BODY_CHARS = 500;
const OVERFLOW_BODY_PATTERN =
  /context.?length|maximum context|prompt.?(too long|too large)|token.?limit|context window|too many tokens/i;
const UNPARSEABLE_ARGS_NOTE = "[unparseable tool arguments]";
const TRUNCATED_TOOL_CALLS_NOTE = "[truncated tool call omitted]";
const REASONING_MODEL_PATTERN = /^(o[1-9]|o[1-9]-|gpt-5)/i;

/**
 * Wire DTOs for the OpenAI chat-completions API. Typed interfaces keep the
 * compiler honest instead of leaning on `any` for request/response shapes.
 */
interface OpenAiChatRequestDto {
  model: string;
  messages: OpenAiMessageDto[];
  tools?: OpenAiToolDto[];
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
}

interface OpenAiMessageDto {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OpenAiToolCallDto[];
  tool_call_id?: string;
}

interface OpenAiToolCallDto {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAiToolDto {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolDefinition["parameters"];
  };
}

interface OpenAiUsageDto {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenAiChoiceDto {
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: Array<{
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string | null;
}

interface OpenAiChatResponseDto {
  model?: string;
  choices?: OpenAiChoiceDto[];
  usage?: OpenAiUsageDto;
}

export class OpenAICompatProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.name = config.name;
    this.model = config.model;
  }

  async chat(
    messages: readonly Message[],
    tools: readonly ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatResult> {
    const api_key = resolve_api_key(this.config);
    if (requires_api_key(this.config) === true && api_key === undefined) {
      throw new ProviderError({
        kind: "auth",
        provider_name: this.config.name,
        message: `missing api key for provider "${this.config.name}" (set api_key, api_key_env, or ${WELL_KNOWN_KEY_ENV})`,
      });
    }
    const response = await do_fetch(
      this.config.fetch_fn ?? fetch,
      build_endpoint(this.config),
      build_request_init(
        api_key,
        safe_stringify(build_request_body(this.config.model, messages, tools, options)),
        build_abort_signal(options, this.config.timeout_ms),
      ),
      this.config.name,
    );
    if (response.ok === false) {
      throw await to_http_error(response, this.config.name);
    }
    return parse_chat_response(await read_success_json(response, this.config.name), this.config);
  }
}

function url_host(url_text: string): string | undefined {
  try {
    return new URL(url_text).host;
  } catch {
    return undefined;
  }
}

function is_well_known_host(config: ProviderConfig): boolean {
  return url_host(config.base_url ?? DEFAULT_BASE_URL) === WELL_KNOWN_HOST;
}

function requires_api_key(config: ProviderConfig): boolean {
  return is_well_known_host(config);
}

function resolve_api_key(config: ProviderConfig): string | undefined {
  const from_named_env = config.api_key_env === undefined ? undefined : process.env[config.api_key_env];
  const from_well_known_env = is_well_known_host(config) === true ? process.env[WELL_KNOWN_KEY_ENV] : undefined;
  return first_non_empty([config.api_key, from_named_env, from_well_known_env]);
}

function first_non_empty(values: ReadonlyArray<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function build_endpoint(config: ProviderConfig): string {
  const base = config.base_url ?? DEFAULT_BASE_URL;
  return base.endsWith("/") === true ? `${base}chat/completions` : `${base}/chat/completions`;
}

function build_headers(api_key: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (api_key !== undefined) {
    headers.authorization = `Bearer ${api_key}`;
  }
  return headers;
}

function build_abort_signal(options: ChatOptions | undefined, timeout_ms: number | undefined): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (timeout_ms !== undefined && timeout_ms > 0) {
    signals.push(AbortSignal.timeout(timeout_ms));
  }
  if (options?.signal !== undefined) {
    signals.push(options.signal);
  }
  const [only_signal] = signals;
  if (only_signal !== undefined && signals.length === 1) {
    return only_signal;
  }
  return AbortSignal.any(signals);
}

function to_openai_messages(messages: readonly Message[]): OpenAiMessageDto[] {
  const wire: OpenAiMessageDto[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      wire.push({ role: "system", content: message.content });
    } else if (message.role === "user") {
      wire.push({ role: "user", content: message.content });
    } else if (message.role === "assistant") {
      wire.push(assistant_to_wire(message));
    } else {
      wire.push(tool_to_wire(message));
    }
  }
  return wire;
}

function assistant_to_wire(message: AssistantMessage): OpenAiMessageDto {
  const wire_calls = (message.tool_calls ?? []).map((tool_call) => ({
    id: tool_call.id,
    type: "function" as const,
    function: { name: tool_call.name, arguments: safe_stringify(tool_call.args) },
  }));
  if (wire_calls.length === 0) {
    return { role: "assistant", content: message.content };
  }
  return { role: "assistant", content: message.content, tool_calls: wire_calls };
}

function tool_to_wire(message: ToolMessage): OpenAiMessageDto {
  return { role: "tool", tool_call_id: message.tool_call_id, content: message.content };
}

function to_openai_tools(tools: readonly ToolDefinition[]): OpenAiToolDto[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

function build_request_body(
  model: string,
  messages: readonly Message[],
  tools: readonly ToolDefinition[],
  options: ChatOptions | undefined,
): OpenAiChatRequestDto {
  const body: OpenAiChatRequestDto = { model, messages: to_openai_messages(messages) };
  const wire_tools = to_openai_tools(tools);
  if (wire_tools.length > 0) {
    body.tools = wire_tools;
  }
  if (options?.temperature !== undefined) {
    body.temperature = options.temperature;
  }
  if (options?.max_tokens !== undefined) {
    if (is_reasoning_model(model) === true) {
      body.max_completion_tokens = options.max_tokens;
    } else {
      body.max_tokens = options.max_tokens;
    }
  }
  return body;
}

function is_reasoning_model(model: string): boolean {
  return REASONING_MODEL_PATTERN.test(model) === true;
}

function build_request_init(api_key: string | undefined, body: string, signal: AbortSignal | undefined): RequestInit {
  return {
    method: "POST",
    headers: build_headers(api_key),
    body,
    ...(signal !== undefined ? { signal } : {}),
  };
}

async function do_fetch(fetch_fn: typeof fetch, url: string, init: RequestInit, provider_name: string): Promise<Response> {
  try {
    return await fetch_fn(url, init);
  } catch (error) {
    const label = is_abort_like(error) === true ? "request aborted or timed out" : "fetch failed";
    throw new ProviderError({
      kind: "network",
      provider_name,
      message: `${label}: ${describe_error(error)}`,
      cause: error,
    });
  }
}

async function read_response_text(response: Response, provider_name: string): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw new ProviderError({
      kind: "network",
      provider_name,
      message: `failed to read response body: ${describe_error(error)}`,
      cause: error,
    });
  }
}

async function read_success_json(response: Response, provider_name: string): Promise<OpenAiChatResponseDto> {
  const text = await read_response_text(response, provider_name);
  const dto = safe_json_parse<OpenAiChatResponseDto>(text);
  if (dto === undefined) {
    throw new ProviderError({
      kind: "bad_request",
      provider_name,
      message: `unparseable success response: ${truncate_text(text, MAX_ERROR_BODY_CHARS)}`,
    });
  }
  return dto;
}

function parse_retry_after_ms(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (raw === null) {
    return undefined;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) === false || seconds < 0) {
    return undefined;
  }
  return Math.round(seconds * 1000);
}

function status_to_error_kind(status: number, body_text: string): ProviderErrorKind {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 429 || status >= 500) {
    return "rate_limit";
  }
  if (status === 413 || (status === 400 && OVERFLOW_BODY_PATTERN.test(body_text) === true)) {
    return "overflow";
  }
  return "bad_request";
}

async function to_http_error(response: Response, provider_name: string): Promise<ProviderError> {
  const body_text = truncate_text(await read_response_text(response, provider_name), MAX_ERROR_BODY_CHARS);
  const retry_after_ms = parse_retry_after_ms(response);
  return new ProviderError({
    kind: status_to_error_kind(response.status, body_text),
    provider_name,
    message: `${provider_name} http ${response.status}: ${body_text}`,
    status: response.status,
    ...(retry_after_ms !== undefined ? { retry_after_ms } : {}),
  });
}

function parse_chat_response(dto: OpenAiChatResponseDto, config: ProviderConfig): ChatResult {
  const choice = dto.choices?.[0];
  if (choice === undefined || choice.message === undefined) {
    throw new ProviderError({
      kind: "bad_request",
      provider_name: config.name,
      message: "provider returned a success response without choices",
    });
  }
  const finish_reason = map_finish_reason(choice.finish_reason);
  return {
    message: parse_assistant_message(choice.message, finish_reason),
    usage: parse_usage(dto.usage),
    finish_reason,
    model: dto.model ?? config.model,
    provider_name: config.name,
  };
}

function parse_assistant_message(
  dto: NonNullable<OpenAiChoiceDto["message"]>,
  finish_reason: FinishReason,
): AssistantMessage {
  const content_parts: string[] = [];
  if (dto.content !== undefined && dto.content !== null && dto.content.length > 0) {
    content_parts.push(dto.content);
  }
  const raw_calls = dto.tool_calls ?? [];
  if (finish_reason === "length" && raw_calls.length > 0) {
    content_parts.push(TRUNCATED_TOOL_CALLS_NOTE);
    return {
      role: "assistant",
      content: content_parts.filter((part) => part.length > 0).join("\n"),
    };
  }
  const tool_calls: ToolCall[] = [];
  for (const raw_call of raw_calls) {
    const raw_arguments = raw_call.function?.arguments ?? "";
    const parsed_arguments =
      raw_arguments.length === 0 ? {} : safe_json_parse<Record<string, unknown>>(raw_arguments);
    if (is_record(parsed_arguments) === true) {
      tool_calls.push({
        id: raw_call.id ?? "",
        name: raw_call.function?.name ?? "",
        args: parsed_arguments,
      });
    } else {
      content_parts.push(UNPARSEABLE_ARGS_NOTE);
    }
  }
  return {
    role: "assistant",
    content: content_parts.filter((part) => part.length > 0).join("\n"),
    ...(tool_calls.length > 0 ? { tool_calls } : {}),
  };
}

function parse_usage(dto: OpenAiUsageDto | undefined): Usage {
  const prompt_tokens = dto?.prompt_tokens ?? 0;
  const completion_tokens = dto?.completion_tokens ?? 0;
  const total_tokens = dto?.total_tokens ?? prompt_tokens + completion_tokens;
  return { prompt_tokens, completion_tokens, total_tokens };
}

function map_finish_reason(raw: string | null | undefined): FinishReason {
  if (raw === "stop") {
    return "stop";
  }
  if (raw === "tool_calls") {
    return "tool_calls";
  }
  if (raw === "length") {
    return "length";
  }
  return "unknown";
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describe_error(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function error_name(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "name" in error) {
    const name = (error as { name?: unknown }).name;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

function is_abort_like(error: unknown): boolean {
  const name = error_name(error);
  return name === "AbortError" || name === "TimeoutError";
}