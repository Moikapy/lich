import { safe_stringify } from "../util/json.js";
import {
  build_abort_signal,
  build_request_init,
  do_fetch,
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
  Usage,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_KEY_ENV = "ANTHROPIC_API_KEY";
const UNPARSEABLE_ARGS_NOTE = "[unparseable tool arguments]";
const TRUNCATED_TOOL_CALLS_NOTE = "[truncated tool call omitted]";
const EMPTY_TEXT_PLACEHOLDER = "(empty)";
const DEFAULT_MAX_TOKENS = 16384;
const ANTHROPIC_TEMP_MAX = 1;

/**
 * Wire DTOs for the Anthropic Messages API (2023-06-01).
 */
interface AnthropicChatRequestDto {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessageDto[];
  tools?: AnthropicToolDto[];
  temperature?: number;
}

interface AnthropicMessageDto {
  role: "user" | "assistant";
  content: AnthropicContentBlockDto[];
}

type AnthropicContentBlockDto =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: Array<{ type: "text"; text: string }>;
      is_error?: boolean;
    }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string };

interface AnthropicToolDto {
  name: string;
  description: string;
  input_schema: ToolDefinition["parameters"];
}

interface AnthropicUsageDto {
  input_tokens?: number;
  output_tokens?: number;
}

interface AnthropicContentBlockResponseDto {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicChatResponseDto {
  model?: string;
  content?: AnthropicContentBlockResponseDto[];
  usage?: AnthropicUsageDto;
  stop_reason?: string | null;
}

interface AnthropicTurnDto {
  role: "user" | "assistant";
  content: AnthropicContentBlockDto[];
}

export class AnthropicProvider implements LLMProvider {
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
    if (api_key === undefined) {
      throw new ProviderError({
        kind: "auth",
        provider_name: this.config.name,
        message: `missing api key for provider "${this.config.name}" (set api_key or api_key_env, e.g. ${DEFAULT_KEY_ENV})`,
      });
    }
    const response = await do_fetch(
      this.config.fetch_fn ?? fetch,
      build_endpoint(this.config),
      build_request_init(
        build_headers(api_key),
        safe_stringify(build_request_body(this.config.model, messages, tools, options, this.config)),
        build_abort_signal(options, this.config.timeout_ms),
      ),
      this.config.name,
    );
    if (response.ok === false) {
      throw await to_http_error(response, this.config.name);
    }
    return parse_chat_response(await read_success_json<AnthropicChatResponseDto>(response, this.config.name), this.config);
  }
}

function resolve_api_key(config: ProviderConfig): string | undefined {
  const direct = config.api_key;
  if (direct !== undefined && direct.length > 0) {
    return direct;
  }
  const env_name = config.api_key_env ?? DEFAULT_KEY_ENV;
  const from_env = process.env[env_name];
  if (from_env !== undefined && from_env.length > 0) {
    return from_env;
  }
  return undefined;
}

function build_endpoint(config: ProviderConfig): string {
  const base = config.base_url ?? DEFAULT_BASE_URL;
  return base.endsWith("/") === true ? `${base}v1/messages` : `${base}/v1/messages`;
}

function build_headers(api_key: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": api_key,
    "anthropic-version": ANTHROPIC_VERSION,
  };
}

function build_request_body(
  model: string,
  messages: readonly Message[],
  tools: readonly ToolDefinition[],
  options: ChatOptions | undefined,
  config: ProviderConfig,
): AnthropicChatRequestDto {
  const body: AnthropicChatRequestDto = {
    model,
    max_tokens: options?.max_tokens ?? DEFAULT_MAX_TOKENS,
    messages: to_anthropic_turns(messages),
  };
  const system_text = collect_system_text(messages);
  if (system_text !== undefined) {
    body.system = system_text;
  }
  if (tools.length > 0) {
    body.tools = to_anthropic_tools(tools);
  }
  if (config.send_temperature === true && options?.temperature !== undefined) {
    body.temperature = Math.min(options.temperature, ANTHROPIC_TEMP_MAX);
  }
  return body;
}

function collect_system_text(messages: readonly Message[]): string | undefined {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      parts.push(message.content);
    }
  }
  const joined = parts.join("\n");
  return joined.length === 0 ? undefined : joined;
}

function to_anthropic_turns(messages: readonly Message[]): AnthropicTurnDto[] {
  const turns: AnthropicTurnDto[] = [];
  const pending_tool_results: AnthropicContentBlockDto[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }
    if (message.role === "tool") {
      pending_tool_results.push(tool_message_to_block(message));
      continue;
    }
    flush_tool_results(turns, pending_tool_results);
    if (message.role === "user") {
      append_user_blocks(turns, [text_block(message.content)]);
    } else {
      turns.push({ role: "assistant", content: assistant_to_blocks(message) });
    }
  }
  flush_tool_results(turns, pending_tool_results);
  return turns;
}

/**
 * Messages API turns must alternate. Compression summaries and a user
 * message after tool results are both `user` in our model; fold them into
 * the open user turn instead of emitting a second one.
 */
function append_user_blocks(
  turns: AnthropicTurnDto[],
  blocks: readonly AnthropicContentBlockDto[],
): void {
  const last = turns.at(-1);
  if (last !== undefined && last.role === "user") {
    for (const block of blocks) {
      last.content.push(block);
    }
    return;
  }
  turns.push({ role: "user", content: [...blocks] });
}

function flush_tool_results(
  turns: AnthropicTurnDto[],
  pending_tool_results: AnthropicContentBlockDto[],
): void {
  if (pending_tool_results.length === 0) {
    return;
  }
  append_user_blocks(turns, pending_tool_results.splice(0, pending_tool_results.length));
}

function text_block(text: string): { type: "text"; text: string } {
  return { type: "text", text: text.length > 0 ? text : EMPTY_TEXT_PLACEHOLDER };
}

function tool_message_to_block(message: Extract<Message, { role: "tool" }>): AnthropicContentBlockDto {
  const block: AnthropicContentBlockDto = {
    type: "tool_result",
    tool_use_id: message.tool_call_id,
    content: [text_block(message.content)],
  };
  if (message.is_error === true) {
    return { ...block, is_error: true };
  }
  return block;
}

function assistant_to_blocks(message: AssistantMessage): AnthropicContentBlockDto[] {
  if (message.provider_content !== undefined && message.provider_content.length > 0) {
    return message.provider_content as AnthropicContentBlockDto[];
  }
  const blocks: AnthropicContentBlockDto[] = [];
  if (message.content.length > 0) {
    blocks.push({ type: "text", text: message.content });
  }
  for (const tool_call of message.tool_calls ?? []) {
    blocks.push({ type: "tool_use", id: tool_call.id, name: tool_call.name, input: tool_call.args });
  }
  if (blocks.length === 0) {
    blocks.push(text_block(""));
  }
  return blocks;
}

function to_anthropic_tools(tools: readonly ToolDefinition[]): AnthropicToolDto[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

function parse_chat_response(dto: AnthropicChatResponseDto, config: ProviderConfig): ChatResult {
  const finish_reason = map_stop_reason(dto.stop_reason);
  return {
    message: parse_assistant_message(dto.content ?? [], finish_reason),
    usage: parse_usage(dto.usage),
    finish_reason,
    model: dto.model ?? config.model,
    provider_name: config.name,
  };
}

function parse_assistant_message(
  blocks: AnthropicContentBlockResponseDto[],
  finish_reason: FinishReason,
): AssistantMessage {
  const text_parts: string[] = [];
  const tool_calls: ToolCall[] = [];
  const provider_content: Record<string, unknown>[] = [];
  let has_thinking = false;
  for (const block of blocks) {
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      has_thinking = true;
      provider_content.push({ ...block });
      continue;
    }
    if (block.type === "text") {
      text_parts.push(block.text ?? "");
      const trimmed_text = (block.text ?? "").trim();
      if (trimmed_text.length > 0) {
        provider_content.push({ type: "text", text: block.text ?? "" });
      }
      continue;
    }
    if (block.type === "tool_use") {
      const call = tool_use_to_call(block, text_parts);
      if (call !== undefined) {
        tool_calls.push(call);
        provider_content.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.args,
        });
      }
    }
  }
  const safe_calls = finish_reason === "length" ? [] : tool_calls;
  if (finish_reason === "length" && tool_calls.length > 0) {
    text_parts.push(TRUNCATED_TOOL_CALLS_NOTE);
  }
  const safe_provider =
    finish_reason === "length"
      ? provider_content.filter((block) => block["type"] !== "tool_use")
      : provider_content;
  return {
    role: "assistant",
    content: text_parts.filter((part) => part.length > 0).join("\n"),
    ...(safe_calls.length > 0 ? { tool_calls: safe_calls } : {}),
    ...(has_thinking === true ? { provider_content: safe_provider } : {}),
  };
}

function tool_use_to_call(
  block: AnthropicContentBlockResponseDto,
  text_parts: string[],
): ToolCall | undefined {
  const args = block.input;
  if (is_record(args) === true) {
    return { id: block.id ?? "", name: block.name ?? "", args };
  }
  text_parts.push(UNPARSEABLE_ARGS_NOTE);
  return undefined;
}

function parse_usage(dto: AnthropicUsageDto | undefined): Usage {
  const prompt_tokens = dto?.input_tokens ?? 0;
  const completion_tokens = dto?.output_tokens ?? 0;
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
  };
}

function map_stop_reason(raw: string | null | undefined): FinishReason {
  if (raw === "end_turn") {
    return "stop";
  }
  if (raw === "tool_use") {
    return "tool_calls";
  }
  if (raw === "max_tokens") {
    return "length";
  }
  return "unknown";
}