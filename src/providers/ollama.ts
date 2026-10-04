import { safe_json_parse, safe_stringify, truncate_text } from "../util/json.js";
import {
  build_abort_signal,
  build_bearer_headers,
  build_request_init,
  do_fetch,
  first_non_empty,
  is_record,
  MAX_ERROR_BODY_CHARS,
  read_success_json,
  to_http_error,
} from "./http.js";
import { ProviderError } from "./types.js";
import type {
  AssistantMessage,
  ChatOptions,
  ChatResult,
  FinishReason,
  LLMProvider,
  Message,
  ProviderConfig,
  ToolCall,
  ToolDefinition,
  ToolMessage,
  Usage,
} from "./types.js";

const DEFAULT_BASE_URL = "http://localhost:11434";
const OVERFLOW_BODY_PATTERN =
  /context.?length|maximum context|prompt(?: is)? too (?:long|large)|token.?limit|context window|too many tokens|too long|exceed.{0,30}context limit/i;
const UNPARSEABLE_ARGS_NOTE = "[unparseable tool arguments]";
const TRUNCATED_TOOL_CALLS_NOTE = "[truncated tool call omitted]";

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
  num_ctx?: number;
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
        build_bearer_headers(resolve_api_key(this.config)),
        safe_stringify(build_request_body(this.config, messages, tools, options)),
        build_abort_signal(options, this.config.timeout_ms),
      ),
      this.config.name,
    );
    if (response.ok === false) {
      throw await to_http_error(response, this.config.name, OVERFLOW_BODY_PATTERN);
    }
    return to_chat_response(await read_success_json<OllamaChatResponseDto>(response, this.config.name), this.config);
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

function build_endpoint(config: ProviderConfig): string {
  const base = config.base_url ?? DEFAULT_BASE_URL;
  return base.endsWith("/") === true ? `${base}api/chat` : `${base}/api/chat`;
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
  const wire_options = build_wire_options(config, options);
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

function build_wire_options(
  config: ProviderConfig,
  options: ChatOptions | undefined,
): OllamaOptionsDto | undefined {
  const wire_options: OllamaOptionsDto = {};
  if (options?.temperature !== undefined) {
    wire_options.temperature = options.temperature;
  }
  if (options?.max_tokens !== undefined) {
    wire_options.num_predict = options.max_tokens;
  }
  if (config.num_ctx !== undefined) {
    wire_options.num_ctx = config.num_ctx;
  }
  const has_any =
    wire_options.temperature !== undefined ||
    wire_options.num_predict !== undefined ||
    wire_options.num_ctx !== undefined;
  return has_any === true ? wire_options : undefined;
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
  const finish_reason = map_done_reason(dto.done_reason, (dto.message.tool_calls ?? []).length > 0);
  const parsed_calls =
    finish_reason === "length"
      ? []
      : parse_tool_calls(dto.message.tool_calls ?? [], content_parts);
  if (finish_reason === "length" && (dto.message.tool_calls ?? []).length > 0) {
    content_parts.push(TRUNCATED_TOOL_CALLS_NOTE);
  }
  const has_tool_calls = parsed_calls.length > 0;
  return {
    message: {
      role: "assistant",
      content: content_parts.join("\n"),
      ...(has_tool_calls === true ? { tool_calls: parsed_calls } : {}),
    },
    usage: parse_usage(dto),
    finish_reason: has_tool_calls === true ? "tool_calls" : finish_reason === "tool_calls" ? "stop" : finish_reason,
    model: dto.model ?? config.model,
    provider_name: config.name,
  };
}

function next_tool_call_id(): string {
  tool_call_counter += 1;
  return `ollama_${Date.now().toString(36)}_${tool_call_counter}`;
}

function parse_tool_calls(raw_calls: OllamaToolCallResponseDto[], content_parts: string[]): ToolCall[] {
  const tool_calls: ToolCall[] = [];
  for (const raw_call of raw_calls) {
    const name = raw_call.function?.name ?? "";
    const args = try_normalize_tool_arguments(raw_call.function?.arguments, content_parts);
    if (args === undefined) {
      continue;
    }
    tool_calls.push({
      id: next_tool_call_id(),
      name,
      args,
    });
  }
  return tool_calls;
}

/**
 * Tool-call arguments arrive as an object per the docs, but some proxies send
 * a JSON string; accept both. Unparseable args are omitted (not executed as {}).
 */
function try_normalize_tool_arguments(
  raw_arguments: unknown,
  content_parts: string[],
): Record<string, unknown> | undefined {
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
  return undefined;
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