import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAICompatProvider } from "../src/providers/openai.js";
import { ProviderError } from "../src/providers/types.js";
import type { ChatOptions, Message, ProviderConfig, ToolDefinition } from "../src/providers/types.js";

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

interface MockReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  text_body?: string;
}

const OPENAI_OK_BODY = {
  model: "gpt-test",
  choices: [
    {
      message: { role: "assistant", content: "hello there" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
};

const SAMPLE_TOOL: ToolDefinition = {
  name: "list_dir",
  description: "List files in a directory",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "directory to list" } },
    required: ["path"],
  },
};

const SAMPLE_MESSAGES: Message[] = [
  { role: "system", content: "be terse" },
  { role: "user", content: "list files" },
  { role: "assistant", content: "", tool_calls: [{ id: "call_1", name: "list_dir", args: { path: "/data" } }] },
  { role: "tool", tool_call_id: "call_1", name: "list_dir", content: "a.txt" },
  { role: "tool", tool_call_id: "call_1", name: "list_dir", content: "b.txt", is_error: true },
];

function mock_fetch(responder: (request: CapturedRequest) => MockReply): {
  fetch_fn: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetch_fn: typeof fetch = (input, init) => {
    const request: CapturedRequest = { url: String(input), init: init ?? {} };
    requests.push(request);
    const reply = responder(request);
    const body_text = reply.text_body ?? JSON.stringify(reply.body ?? {});
    return Promise.resolve(new Response(body_text, { status: reply.status, headers: reply.headers }));
  };
  return { fetch_fn, requests };
}

function openai_config(overrides?: Partial<ProviderConfig>): ProviderConfig {
  return { kind: "openai_compat", name: "openai-main", model: "gpt-test", api_key: "sk-test", ...overrides };
}

function anthropic_config(overrides?: Partial<ProviderConfig>): ProviderConfig {
  return { kind: "anthropic", name: "claude-main", model: "claude-test", api_key: "ak-test", ...overrides };
}

function request_json(request: CapturedRequest): Record<string, unknown> {
  const body_text = typeof request.init.body === "string" ? request.init.body : "";
  return JSON.parse(body_text) as Record<string, unknown>;
}

function request_headers(request: CapturedRequest): Record<string, string> {
  return request.init.headers as Record<string, string>;
}

function as_record(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  return value as Record<string, unknown>;
}

function as_array(value: unknown): unknown[] {
  expect(Array.isArray(value)).toBe(true);
  return value as unknown[];
}

describe("openai compat provider", () => {
  it("maps messages, tool calls, and tools into the request body", async () => {
    const { fetch_fn, requests } = mock_fetch(() => ({ status: 200, body: OPENAI_OK_BODY }));
    const provider = new OpenAICompatProvider(openai_config({ fetch_fn }));
    const options: ChatOptions = { temperature: 0.2, max_tokens: 128 };
    await provider.chat(SAMPLE_MESSAGES, [SAMPLE_TOOL], options);
    expect(requests.length).toBe(1);
    const [first_request] = requests;
    expect(first_request?.url).toBe("https://api.openai.com/v1/chat/completions");
    if (first_request === undefined) {
      return;
    }
    expect(request_headers(first_request)["authorization"]).toBe("Bearer sk-test");
    const body = request_json(first_request);
    expect(body["model"]).toBe("gpt-test");
    expect(body["temperature"]).toBe(0.2);
    expect(body["max_tokens"]).toBe(128);
    expect(as_array(body["messages"])).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "list_dir", arguments: '{"path":"/data"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "a.txt" },
      { role: "tool", tool_call_id: "call_1", content: "b.txt" },
    ]);
    expect(as_array(body["tools"])).toEqual([
      {
        type: "function",
        function: {
          name: "list_dir",
          description: "List files in a directory",
          parameters: SAMPLE_TOOL.parameters,
        },
      },
    ]);
  });

  it("uses a custom base_url without requiring an api key", async () => {
    const { fetch_fn, requests } = mock_fetch(() => ({ status: 200, body: OPENAI_OK_BODY }));
    const provider = new OpenAICompatProvider(
      openai_config({ name: "local", base_url: "http://127.0.0.1:9000/v1", api_key: undefined, fetch_fn }),
    );
    const result = await provider.chat([{ role: "user", content: "hi" }], []);
    expect(result.provider_name).toBe("local");
    const [first_request] = requests;
    expect(first_request?.url).toBe("http://127.0.0.1:9000/v1/chat/completions");
    if (first_request === undefined) {
      return;
    }
    expect(request_headers(first_request)["authorization"]).toBeUndefined();
  });

  it("parses the success response including tool calls, usage, and finish reason", async () => {
    const { fetch_fn } = mock_fetch(() => ({
      status: 200,
      body: {
        model: "gpt-test",
        choices: [
          {
            message: {
              role: "assistant",
              content: "doing it",
              tool_calls: [
                { id: "call_9", type: "function", function: { name: "list_dir", arguments: '{"path":"/x"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      },
    }));
    const provider = new OpenAICompatProvider(openai_config({ fetch_fn }));
    const result = await provider.chat([{ role: "user", content: "go" }], [SAMPLE_TOOL]);
    expect(result.message.content).toBe("doing it");
    expect(result.message.tool_calls?.[0]).toEqual({
      id: "call_9",
      name: "list_dir",
      args: { path: "/x" },
    });
    expect(result.finish_reason).toBe("tool_calls");
    expect(result.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
    expect(result.model).toBe("gpt-test");
    expect(result.provider_name).toBe("openai-main");
  });

  it("omits executable tool calls and appends a note when arguments do not parse", async () => {
    const { fetch_fn } = mock_fetch(() => ({
      status: 200,
      body: {
        choices: [
          {
            message: {
              role: "assistant",
              content: "trying",
              tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{not json" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    }));
    const provider = new OpenAICompatProvider(openai_config({ fetch_fn }));
    const result = await provider.chat([{ role: "user", content: "go" }], [SAMPLE_TOOL]);
    expect(result.message.tool_calls).toBeUndefined();
    expect(result.message.content).toContain("[unparseable tool arguments]");
  });

  it("omits tool calls when finish_reason is length", async () => {
    const { fetch_fn } = mock_fetch(() => ({
      status: 200,
      body: {
        choices: [
          {
            message: {
              role: "assistant",
              content: "partial",
              tool_calls: [
                { id: "c1", type: "function", function: { name: "write_file", arguments: '{"path":"/x","content":"ab' } },
              ],
            },
            finish_reason: "length",
          },
        ],
      },
    }));
    const provider = new OpenAICompatProvider(openai_config({ fetch_fn }));
    const result = await provider.chat([{ role: "user", content: "go" }], [SAMPLE_TOOL]);
    expect(result.finish_reason).toBe("length");
    expect(result.message.tool_calls).toBeUndefined();
    expect(result.message.content).toContain("[truncated tool call omitted]");
  });

  it("sends max_completion_tokens for reasoning models", async () => {
    const { fetch_fn, requests } = mock_fetch(() => ({ status: 200, body: OPENAI_OK_BODY }));
    const provider = new OpenAICompatProvider(openai_config({ model: "o3-mini", fetch_fn }));
    await provider.chat([{ role: "user", content: "hi" }], [], { max_tokens: 128 });
    const body = request_json(requests[0]!);
    expect(body["max_completion_tokens"]).toBe(128);
    expect(body["max_tokens"]).toBeUndefined();
  });

  it("maps 413 and tight context overflow, not bare token mentions", async () => {
    const overflow_mock = mock_fetch(() => ({
      status: 400,
      text_body: "prompt too long: context length exceeded",
    }));
    const overflow_provider = new OpenAICompatProvider(openai_config({ fetch_fn: overflow_mock.fetch_fn }));
    const overflow_failure = await overflow_provider.chat([{ role: "user", content: "go" }], []).catch((e: unknown) => e);
    expect((overflow_failure as ProviderError).kind).toBe("overflow");

    const payload_mock = mock_fetch(() => ({
      status: 400,
      text_body: "unknown field max_tokens; use max_completion_tokens",
    }));
    const payload_provider = new OpenAICompatProvider(openai_config({ fetch_fn: payload_mock.fetch_fn }));
    const payload_failure = await payload_provider.chat([{ role: "user", content: "go" }], []).catch((e: unknown) => e);
    expect((payload_failure as ProviderError).kind).toBe("bad_request");

    const too_large_mock = mock_fetch(() => ({ status: 413, text_body: "payload too large" }));
    const too_large_provider = new OpenAICompatProvider(openai_config({ fetch_fn: too_large_mock.fetch_fn }));
    const too_large_failure = await too_large_provider.chat([{ role: "user", content: "go" }], []).catch((e: unknown) => e);
    expect((too_large_failure as ProviderError).kind).toBe("overflow");
  });

  it("defaults usage to zeros and unknown finish reasons", async () => {
    const { fetch_fn } = mock_fetch(() => ({
      status: 200,
      body: { choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "weird" }] },
    }));
    const provider = new OpenAICompatProvider(openai_config({ fetch_fn }));
    const result = await provider.chat([{ role: "user", content: "go" }], []);
    expect(result.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    expect(result.finish_reason).toBe("unknown");
  });

  it("maps 429 with a numeric Retry-After header to rate_limit", async () => {
    const { fetch_fn } = mock_fetch(() => ({
      status: 429,
      body: { error: { message: "slow down" } },
      headers: { "retry-after": "2" },
    }));
    const provider = new OpenAICompatProvider(openai_config({ fetch_fn }));
    const failure = await provider.chat([{ role: "user", content: "go" }], []).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    const provider_error = failure as ProviderError;
    expect(provider_error.kind).toBe("rate_limit");
    expect(provider_error.retry_after_ms).toBe(2000);
    expect(provider_error.status).toBe(429);
  });

  it("maps 401 to auth and a context-heavy 400 to overflow", async () => {
    const auth_mock = mock_fetch(() => ({ status: 401, body: { error: { message: "bad key" } } }));
    const auth_provider = new OpenAICompatProvider(openai_config({ fetch_fn: auth_mock.fetch_fn }));
    const auth_failure = await auth_provider.chat([{ role: "user", content: "go" }], []).catch((e: unknown) => e);
    expect((auth_failure as ProviderError).kind).toBe("auth");

    const overflow_mock = mock_fetch(() => ({
      status: 400,
      text_body: "prompt too long: context length exceeded",
    }));
    const overflow_provider = new OpenAICompatProvider(openai_config({ fetch_fn: overflow_mock.fetch_fn }));
    const overflow_failure = await overflow_provider.chat([{ role: "user", content: "go" }], []).catch((e: unknown) => e);
    expect((overflow_failure as ProviderError).kind).toBe("overflow");
  });

  it("treats 5xx as transient rate_limit while preserving status", async () => {
    const { fetch_fn } = mock_fetch(() => ({ status: 503, text_body: "upstream unavailable" }));
    const provider = new OpenAICompatProvider(openai_config({ fetch_fn }));
    const failure = await provider.chat([{ role: "user", content: "go" }], []).catch((e: unknown) => e);
    const provider_error = failure as ProviderError;
    expect(provider_error.kind).toBe("rate_limit");
    expect(provider_error.status).toBe(503);
  });

  it("passes an abort signal through to the underlying fetch", async () => {
    const { fetch_fn, requests } = mock_fetch(() => ({ status: 200, body: OPENAI_OK_BODY }));
    const provider = new OpenAICompatProvider(openai_config({ fetch_fn, timeout_ms: 5000 }));
    await provider.chat([{ role: "user", content: "go" }], []);
    const [first_request] = requests;
    expect(first_request?.init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("anthropic provider", () => {
  it("extracts system text and merges consecutive tool messages into one user turn", async () => {
    const { fetch_fn, requests } = mock_fetch(() => ({
      status: 200,
      body: {
        model: "claude-test",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }));
    const provider = new AnthropicProvider(anthropic_config({ fetch_fn, send_temperature: true }));
    await provider.chat(SAMPLE_MESSAGES, [SAMPLE_TOOL], { temperature: 0.1, max_tokens: 256 });
    expect(requests.length).toBe(1);
    const [first_request] = requests;
    expect(first_request?.url).toBe("https://api.anthropic.com/v1/messages");
    if (first_request === undefined) {
      return;
    }
    const headers = request_headers(first_request);
    expect(headers["x-api-key"]).toBe("ak-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["content-type"]).toBe("application/json");
    const body = request_json(first_request);
    expect(body["system"]).toBe("be terse");
    expect(body["max_tokens"]).toBe(256);
    expect(body["temperature"]).toBe(0.1);
    expect(as_array(body["messages"])).toEqual([
      { role: "user", content: [{ type: "text", text: "list files" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "list_dir", input: { path: "/data" } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: [{ type: "text", text: "a.txt" }],
          },
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: [{ type: "text", text: "b.txt" }],
            is_error: true,
          },
        ],
      },
    ]);
    expect(as_array(body["tools"])).toEqual([
      {
        name: "list_dir",
        description: "List files in a directory",
        input_schema: SAMPLE_TOOL.parameters,
      },
    ]);
  });

  it("parses text plus tool_use blocks and maps usage and stop reasons", async () => {
    const { fetch_fn } = mock_fetch(() => ({
      status: 200,
      body: {
        model: "claude-test",
        content: [
          { type: "text", text: "thinking" },
          { type: "text", text: "more" },
          { type: "tool_use", id: "tu_1", name: "list_dir", input: { path: "/data" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 9, output_tokens: 11 },
      },
    }));
    const provider = new AnthropicProvider(anthropic_config({ fetch_fn }));
    const result = await provider.chat([{ role: "user", content: "go" }], [SAMPLE_TOOL]);
    expect(result.message.content).toBe("thinking\nmore");
    expect(result.message.tool_calls?.[0]).toEqual({
      id: "tu_1",
      name: "list_dir",
      args: { path: "/data" },
    });
    expect(result.finish_reason).toBe("tool_calls");
    expect(result.usage).toEqual({ prompt_tokens: 9, completion_tokens: 11, total_tokens: 20 });
    expect(result.model).toBe("claude-test");
  });

  it("maps max_tokens and end_turn stop reasons", async () => {
    const run_case = async (stop_reason: string): Promise<string> => {
      const { fetch_fn } = mock_fetch(() => ({
        status: 200,
        body: {
          content: [{ type: "text", text: "partial" }],
          stop_reason,
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      }));
      const provider = new AnthropicProvider(anthropic_config({ fetch_fn }));
      const result = await provider.chat([{ role: "user", content: "go" }], []);
      return result.finish_reason;
    };
    expect(await run_case("max_tokens")).toBe("length");
    expect(await run_case("end_turn")).toBe("stop");
    expect(await run_case("something_else")).toBe("unknown");
  });

  it("omits executable tool calls when tool_use input is not an object", async () => {
    const { fetch_fn } = mock_fetch(() => ({
      status: 200,
      body: {
        content: [{ type: "tool_use", id: "tu_2", name: "f", input: "not-an-object" }],
        stop_reason: "tool_use",
      },
    }));
    const provider = new AnthropicProvider(anthropic_config({ fetch_fn }));
    const result = await provider.chat([{ role: "user", content: "go" }], [SAMPLE_TOOL]);
    expect(result.message.tool_calls).toBeUndefined();
    expect(result.message.content).toContain("[unparseable tool arguments]");
  });

  it("defaults max_tokens to 16384 and omits temperature unless send_temperature", async () => {
    const { fetch_fn, requests } = mock_fetch(() => ({
      status: 200,
      body: {
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }));
    const provider = new AnthropicProvider(anthropic_config({ fetch_fn }));
    await provider.chat([{ role: "user", content: "hi" }], [], { temperature: 0.7 });
    const body = request_json(requests[0]!);
    expect(body["max_tokens"]).toBe(16384);
    expect(body["temperature"]).toBeUndefined();
  });

  it("omits tool calls when stop_reason is max_tokens", async () => {
    const { fetch_fn } = mock_fetch(() => ({
      status: 200,
      body: {
        content: [{ type: "tool_use", id: "tu_3", name: "write_file", input: { path: "/x", content: "ab" } }],
        stop_reason: "max_tokens",
      },
    }));
    const provider = new AnthropicProvider(anthropic_config({ fetch_fn }));
    const result = await provider.chat([{ role: "user", content: "go" }], [SAMPLE_TOOL]);
    expect(result.finish_reason).toBe("length");
    expect(result.message.tool_calls).toBeUndefined();
    expect(result.message.content).toContain("[truncated tool call omitted]");
  });

  it("preserves thinking blocks on round-trip via provider_content", async () => {
    const thinking_block = {
      type: "thinking",
      thinking: "plan steps",
      signature: "sig_abc",
    };
    const { fetch_fn, requests } = mock_fetch(() => ({
      status: 200,
      body: {
        content: [
          thinking_block,
          { type: "text", text: "done" },
          { type: "tool_use", id: "tu_t", name: "list_dir", input: { path: "/" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    }));
    const provider = new AnthropicProvider(anthropic_config({ fetch_fn }));
    const result = await provider.chat([{ role: "user", content: "go" }], [SAMPLE_TOOL]);
    expect(result.message.provider_content?.[0]).toEqual(thinking_block);
    expect(result.message.tool_calls?.[0]?.name).toBe("list_dir");
    await provider.chat(
      [
        { role: "user", content: "go" },
        result.message,
        { role: "tool", tool_call_id: "tu_t", name: "list_dir", content: "ok" },
      ],
      [SAMPLE_TOOL],
    );
    const replay = as_array(request_json(requests[1]!)["messages"]);
    const assistant_turn = as_record(replay[1]);
    expect(as_array(assistant_turn["content"])[0]).toEqual(thinking_block);
  });

  it("throws auth without calling fetch when no api key is configured", async () => {
    const saved_key = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      const { fetch_fn, requests } = mock_fetch(() => ({ status: 200, body: {} }));
      const provider = new AnthropicProvider({ kind: "anthropic", name: "claude-nokey", model: "claude-test", fetch_fn });
      const failure = await provider.chat([{ role: "user", content: "hi" }], []).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ProviderError);
      expect((failure as ProviderError).kind).toBe("auth");
      expect(requests.length).toBe(0);
    } finally {
      if (saved_key !== undefined) {
        process.env["ANTHROPIC_API_KEY"] = saved_key;
      }
    }
  });

  it("never emits empty text blocks for blank user, tool, or assistant content", async () => {
    const { fetch_fn, requests } = mock_fetch(() => ({
      status: 200,
      body: {
        model: "claude-test",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }));
    const provider = new AnthropicProvider(anthropic_config({ fetch_fn }));
    await provider.chat(
      [
        { role: "user", content: "" },
        { role: "assistant", content: "" },
        { role: "user", content: "retry" },
        { role: "assistant", content: "", tool_calls: [{ id: "call_1", name: "list_dir", args: { path: "/" } }] },
        { role: "tool", tool_call_id: "call_1", name: "list_dir", content: "" },
      ],
      [SAMPLE_TOOL],
    );
    const body = request_json(requests[0]!);
    expect(as_array(body["messages"])).toEqual([
      { role: "user", content: [{ type: "text", text: "(empty)" }] },
      { role: "assistant", content: [{ type: "text", text: "(empty)" }] },
      { role: "user", content: [{ type: "text", text: "retry" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "list_dir", input: { path: "/" } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: [{ type: "text", text: "(empty)" }],
          },
        ],
      },
    ]);
  });
});