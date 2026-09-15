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

  it("keeps empty args and appends a note when tool arguments do not parse", async () => {
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
    expect(result.message.tool_calls?.[0]?.args).toEqual({});
    expect(result.message.content).toContain("[unparseable tool arguments]");
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
    const provider = new AnthropicProvider(anthropic_config({ fetch_fn }));
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

  it("keeps empty args and appends a note when tool_use input is not an object", async () => {
    const { fetch_fn } = mock_fetch(() => ({
      status: 200,
      body: {
        content: [{ type: "tool_use", id: "tu_2", name: "f", input: "not-an-object" }],
        stop_reason: "tool_use",
      },
    }));
    const provider = new AnthropicProvider(anthropic_config({ fetch_fn }));
    const result = await provider.chat([{ role: "user", content: "go" }], [SAMPLE_TOOL]);
    expect(result.message.tool_calls?.[0]?.args).toEqual({});
    expect(result.message.content).toContain("[unparseable tool arguments]");
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
});