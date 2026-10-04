import { safe_json_parse, safe_stringify } from "../util/json.js";
import {
  build_abort_signal,
  build_bearer_headers,
  build_request_init,
  do_fetch,
  first_non_empty,
  is_record,
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

/** Tool calls the server sent without an id still need a unique one to pair with their results. */
let tool_call_counter = 0;

function next_tool_call_id(): string {
  tool_call_counter += 1;
  return `openai_${Date.now().toString(36)}_${tool_call_counter}`;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const WELL_KNOWN_HOST = "api.openai.com";
const WELL_KNOWN_KEY_ENV = "OPENAI_API_KEY";
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
        build_bearer_headers(api_key),
        safe_stringify(build_request_body(this.config.model, messages, tools, options)),
        build_abort_signal(options, this.config.timeout_ms),
      ),
      this.config.name,
    );
    if (response.ok === false) {
      throw await to_http_error(response, this.config.name);
    }
    return parse_chat_response(await read_success_json<OpenAiChatResponseDto>(response, this.config.name), this.config);
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

function build_endpoint(config: ProviderConfig): string {
  const base = config.base_url ?? DEFAULT_BASE_URL;
  return base.endsWith("/") === true ? `${base}chat/completions` : `${base}/chat/completions`;
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
  if (options?.temperature !== undefined && is_reasoning_model(model) === false) {
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
        id: typeof raw_call.id === "string" && raw_call.id.length > 0 ? raw_call.id : next_tool_call_id(),
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