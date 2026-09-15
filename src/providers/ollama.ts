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

const DEFAULT_BASE_URL = "http://localhost:11434";
const MAX_ERROR_BODY_CHARS = 500;
const OVERFLOW_BODY_PATTERN = /context|token|maximum|too long/i;
const UNPARSEABLE_ARGS_NOTE = "[unparseable tool arguments]";

let tool_call_counter = 0;

/**
 * Wire DTOs for the Ollama chat API (/api/chat). Typed interfaces keep the
 * compiler honest instead of leaning on `any` for request/response shapes.
 */
interface OllamaChatRequestDto {
  model: string;
  messages: OllamaMessageDto[];
  stream: false;
  tools?: OllamaToolDto[];
  options?: OllamaOptionsDto;
  think?: boolean;
  keep_alive?: string;
}

interface OllamaMessageDto {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCallDto[];
  tool_name?: string;
}

interface OllamaToolCallDto {
  type: "function";
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaToolDto {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolDefinition["parameters"];
  };
}

interface OllamaOptionsDto {
  temperature?: number;
  num_predict?: number;
}

interface OllamaToolCallResponseDto {
  function?: {
    name?: string;
    arguments?: unknown;
  };
}

interface OllamaMessageResponseDto {
  role?: string;
  content?: string | null;
  thinking?: string;
  tool_calls?: OllamaToolCallResponseDto[];
}

interface OllamaChatResponseDto {
  model?: string;
  message?: OllamaMessageResponseDto;
  done?: boolean;
  done_reason?: string;
  error?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Provider for a local or remote Ollama server (POST /api/chat). Ollama
 * requires no api key; when api_key/api_key_env resolve, a Bearer header is
 * sent for cloud proxies that need auth.
 */
export class OllamaProvider implements LLMProvider {
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
    const response = await do_fetch(
      this.config.fetch_fn ?? fetch,
      build_endpoint(this.config),
      build_request_init(
        resolve_api_key(this.config),
        safe_stringify(build_request_body(this.config, messages, tools, options)),
        build_abort_signal(options, this.config.timeout_ms),
      ),
      this.config.name,
    );
    if (response.ok === false) {
      throw await to_http_error(response, this.config.name);
    }
    return to_chat_response(await read_success_json(response, this.config.name), this.config);
  }
}

export function create_ollama_provider(config: ProviderConfig): OllamaProvider {
  return new OllamaProvider(config);
}

/**
 * Ollama needs no key by default, so an unresolvable key stays non-fatal;
 * when api_key/api_key_env do resolve, cloud proxies get a Bearer header.
 */
function resolve_api_key(config: ProviderConfig): string | undefined {
  const from_named_env = config.api_key_env === undefined ? undefined : process.env[config.api_key_env];
  return first_non_empty([config.api_key, from_named_env]);
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
  return base.endsWith("/") === true ? `${base}api/chat` : `${base}/api/chat`;
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

function to_ollama_messages(messages: readonly Message[]): OllamaMessageDto[] {
  const wire: OllamaMessageDto[] = [];
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

/**
 * Ollama takes tool arguments as an object (not a JSON string like OpenAI)
 * and uses tool_name (not name/tool_call_id) on tool messages, sent 1:1.
 */
function assistant_to_wire(message: AssistantMessage): OllamaMessageDto {
  const wire_calls = (message.tool_calls ?? []).map((tool_call) => ({
    type: "function" as const,
    function: { name: tool_call.name, arguments: tool_call.args },
  }));
  if (wire_calls.length === 0) {
    return { role: "assistant", content: message.content };
  }
  return { role: "assistant", content: message.content, tool_calls: wire_calls };
}

function tool_to_wire(message: ToolMessage): OllamaMessageDto {
  return { role: "tool", tool_name: message.name, content: message.content };
}

function to_ollama_tools(tools: readonly ToolDefinition[]): OllamaToolDto[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

function build_request_body(
  config: ProviderConfig,
  messages: readonly Message[],
  tools: readonly ToolDefinition[],
  options: ChatOptions | undefined,
): OllamaChatRequestDto {
  const body: OllamaChatRequestDto = { model: config.model, messages: to_ollama_messages(messages), stream: false };
  const wire_tools = to_ollama_tools(tools);
  if (wire_tools.length > 0) {
    body.tools = wire_tools;
  }
  const wire_options = build_wire_options(options);
  if (wire_options !== undefined) {
    body.options = wire_options;
  }
  if (options?.think === true || config.think === true) {
    body.think = true;
  }
  if (config.keep_alive !== undefined) {
    body.keep_alive = config.keep_alive;
  }
  return body;
}

function build_wire_options(options: ChatOptions | undefined): OllamaOptionsDto | undefined {
  const wire_options: OllamaOptionsDto = {};
  if (options?.temperature !== undefined) {
    wire_options.temperature = options.temperature;
  }
  if (options?.max_tokens !== undefined) {
    wire_options.num_predict = options.max_tokens;
  }
  const has_any = wire_options.temperature !== undefined || wire_options.num_predict !== undefined;
  return has_any === true ? wire_options : undefined;
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

async function read_success_json(response: Response, provider_name: string): Promise<OllamaChatResponseDto> {
  const text = await read_response_text(response, provider_name);
  const dto = safe_json_parse<OllamaChatResponseDto>(text);
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
  if (status === 400 && OVERFLOW_BODY_PATTERN.test(body_text) === true) {
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

function to_chat_response(dto: OllamaChatResponseDto, config: ProviderConfig): ChatResult {
  if (dto.error !== undefined && dto.error.length > 0) {
    throw new ProviderError({
      kind: "bad_request",
      provider_name: config.name,
      message: `ollama reported an error in a 200 response: ${truncate_text(dto.error, MAX_ERROR_BODY_CHARS)}`,
    });
  }
  if (dto.message === undefined) {
    throw new ProviderError({
      kind: "bad_request",
      provider_name: config.name,
      message: "provider returned a success response without a message",
    });
  }
  const content_parts: string[] = [];
  const message_content = dto.message.content ?? "";
  if (message_content.length > 0) {
    content_parts.push(message_content);
  }
  const parsed_calls = parse_tool_calls(dto.message.tool_calls ?? [], content_parts);
  const has_tool_calls = parsed_calls.length > 0;
  return {
    message: {
      role: "assistant",
      content: content_parts.join("\n"),
      ...(has_tool_calls === true ? { tool_calls: parsed_calls } : {}),
    },
    usage: parse_usage(dto),
    finish_reason: map_done_reason(dto.done_reason, has_tool_calls),
    model: dto.model ?? config.model,
    provider_name: config.name,
  };
}

function next_tool_call_id(): string {
  tool_call_counter += 1;
  return `ollama_${Date.now().toString(36)}_${tool_call_counter}`;
}

/**
 * Tool-call arguments arrive as an object per the docs, but some proxies send
 * a JSON string; accept both and fall back to empty args with a note.
 */
function normalize_tool_arguments(raw_arguments: unknown, content_parts: string[]): Record<string, unknown> {
  if (is_record(raw_arguments) === true) {
    return raw_arguments;
  }
  if (typeof raw_arguments === "string") {
    const parsed = safe_json_parse<unknown>(raw_arguments);
    if (is_record(parsed) === true) {
      return parsed;
    }
  }
  content_parts.push(UNPARSEABLE_ARGS_NOTE);
  return {};
}

function parse_tool_calls(raw_calls: OllamaToolCallResponseDto[], content_parts: string[]): ToolCall[] {
  const tool_calls: ToolCall[] = [];
  for (const raw_call of raw_calls) {
    const name = raw_call.function?.name ?? "";
    tool_calls.push({
      id: next_tool_call_id(),
      name,
      args: normalize_tool_arguments(raw_call.function?.arguments, content_parts),
    });
  }
  return tool_calls;
}

function parse_usage(dto: OllamaChatResponseDto): Usage {
  const prompt_tokens = dto.prompt_eval_count ?? 0;
  const completion_tokens = dto.eval_count ?? 0;
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
}

/**
 * Load-bearing mapping: Ollama reports done_reason "stop" even when tool
 * calls are present, so presence of tool_calls wins over done_reason.
 */
function map_done_reason(done_reason: string | undefined, has_tool_calls: boolean): FinishReason {
  if (has_tool_calls === true) {
    return "tool_calls";
  }
  if (done_reason === "stop" || done_reason === "end_turn") {
    return "stop";
  }
  if (done_reason === "length" || done_reason === "max_tokens") {
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