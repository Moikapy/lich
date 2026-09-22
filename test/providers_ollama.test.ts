import { describe, expect, it } from "vitest";
import { create_ollama_provider, OllamaProvider } from "../src/providers/ollama.js";
import { chat_with_failover, ProviderRouter } from "../src/providers/router.js";
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

function ollama_config(overrides?: Partial<ProviderConfig>): ProviderConfig {
  return { kind: "ollama", name: "local-ollama", model: "llama3.2:latest", ...overrides };
}

function ok_body(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    model: "llama3.2:latest",
    message: { role: "assistant", content: "hello there" },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 5,
    eval_count: 7,
    ...overrides,
  };
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

describe("ollama provider", () => {
  it("maps messages and tools into the ollama request body", async () => {
    const { fetch_fn, requests } = mock_fetch(() => ({ status: 200, body: ok_body() }));
    const provider = new OllamaProvider(ollama_config({ fetch_fn }));
    const options: ChatOptions = { temperature: 0.2, max_tokens: 128 };
    await provider.chat(SAMPLE_MESSAGES, [SAMPLE_TOOL], options);
    expect(requests.length).toBe(1);
    const [first_request] = requests;
    expect(first_request?.url).toBe("http://localhost:11434/api/chat");
    if (first_request === undefined) {
      return;
    }
    expect(request_headers(first_request)["content-type"]).toBe("application/json");
    expect(request_headers(first_request)["authorization"]).toBeUndefined();
    const body = request_json(first_request);
    expect(body["model"]).toBe("llama3.2:latest");
    expect(body["stream"]).toBe(false);
    expect(body["temperature"]).toBeUndefined();
    expect(as_array(body["messages"])).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { type: "function", function: { name: "list_dir", arguments: { path: "/data" } } },
        ],
      },
      { role: "tool", tool_name: "list_dir", content: "a.txt" },
      { role: "tool", tool_name: "list_dir", content: "b.txt" },
    ]);
    const tool_messages = as_array(body["messages"]).filter(
      (message) => as_record(message)["role"] === "tool",
    );
    expect(tool_messages.length).toBe(2);
    for (const tool_message of tool_messages) {
      expect(Object.hasOwn(as_record(tool_message), "tool_call_id")).toBe(false);
    }
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
    expect(as_record(body["options"])).toEqual({ temperature: 0.2, num_predict: 128 });
  });

  it("uses a custom base_url and passes no api key", async () => {
    const { fetch_fn, requests } = mock_fetch(() => ({ status: 200, body: ok_body() }));
    const provider = new OllamaProvider(ollama_config({ name: "remote", base_url: "http://10.0.0.5:11434/", fetch_fn }));
    const result = await provider.chat([{ role: "user", content: "hi" }], []);
    expect(result.provider_name).toBe("remote");
    const [first_request] = requests;
    expect(first_request?.url).toBe("http://10.0.0.5:11434/api/chat");
    if (first_request === undefined) {
      return;
    }
    expect(request_headers(first_request)["authorization"]).toBeUndefined();
  });

  it("sends a bearer authorization header when api_key is set", async () => {
    const { fetch_fn, requests } = mock_fetch(() => ({ status: 200, body: ok_body() }));
    const provider = new OllamaProvider(ollama_config({ fetch_fn, api_key: "sk-cloud-test" }));
    await provider.chat([{ role: "user", content: "hi" }], []);
    const [first_request] = requests;
    if (first_request === undefined) {
      return;
    }
    expect(request_headers(first_request)["authorization"]).toBe("Bearer sk-cloud-test");
  });

  it("sends no authorization header when no key resolves", async () => {
    const { fetch_fn, requests } = mock_fetch(() => ({ status: 200, body: ok_body() }));
    const provider = new OllamaProvider(ollama_config({ fetch_fn }));
    await provider.chat([{ role: "user", content: "hi" }], []);
    const [first_request] = requests;
    if (first_request === undefined) {
      return;
    }
    expect(request_headers(first_request)["authorization"]).toBeUndefined();
  });

  it("resolves the bearer header from api_key_env when the env var is present", async () => {
    const saved_key = process.env["TEST_OLLAMA_API_KEY"];
    process.env["TEST_OLLAMA_API_KEY"] = "env-key-123";
    try {
      const { fetch_fn, requests } = mock_fetch(() => ({ status: 200, body: ok_body() }));
      const provider = new OllamaProvider(ollama_config({ fetch_fn, api_key_env: "TEST_OLLAMA_API_KEY" }));
      await provider.chat([{ role: "user", content: "hi" }], []);
      const [first_request] = requests;
      if (first_request === undefined) {
        return;
      }
      expect(request_headers(first_request)["authorization"]).toBe("Bearer env-key-123");
    } finally {
      if (saved_key === undefined) {
        delete process.env["TEST_OLLAMA_API_KEY"];
      } else {
        process.env["TEST_OLLAMA_API_KEY"] = saved_key;
      }
    }
  });

  it("omits empty options, tools, and think keys when not configured", async () => {
    const { fetch_fn, requests } = mock_fetch(() => ({ status: 200, body: ok_body() }));
    const provider = new OllamaProvider(ollama_config({ fetch_fn }));
    await provider.chat([{ role: "user", content: "hi" }], []);
    const body = request_json(requests[0] as CapturedRequest);
    expect(body["tools"]).toBeUndefined();
    expect(body["options"]).toBeUndefined();
    expect(body["think"]).toBeUndefined();
    expect(body["keep_alive"]).toBeUndefined();
  });

  it("adds think and keep_alive to the body when configured", async () => {
    const { fetch_fn, requests } = mock_fetch(() => ({ status: 200, body: ok_body() }));
    const provider = new OllamaProvider(ollama_config({ fetch_fn, think: true, keep_alive: "10m" }));
    await provider.chat([{ role: "user", content: "hi" }], []);
    const body = request_json(requests[0] as CapturedRequest);
    expect(body["think"]).toBe(true);
    expect(body["keep_alive"]).toBe("10m");
  });

  it("adds think from chat options as well as config", async () => {
    const { fetch_fn, requests } = mock_fetch(() => ({ status: 200, body: ok_body() }));
    const provider = new OllamaProvider(ollama_config({ fetch_fn }));
    await provider.chat([{ role: "user", content: "hi" }], [], { think: true });
    const body = request_json(requests[0] as CapturedRequest);
    expect(body["think"]).toBe(true);
  });

  it("parses content, tool calls, usage, and model echo from the response", async () => {
    const { fetch_fn } = mock_fetch(() => ({
      status: 200,
      body: ok_body({
        message: {
          role: "assistant",
          content: "doing it",
          tool_calls: [{ function: { name: "list_dir", arguments: { path: "/x" } } }],
        },
        done_reason: "stop",
      }),
    }));
    const provider = new OllamaProvider(ollama_config({ fetch_fn }));
    const result = await provider.chat([{ role: "user", content: "go" }], [SAMPLE_TOOL]);
    expect(result.message.content).toBe("doing it");
    const first_call = result.message.tool_calls?.[0];
    expect(first_call?.name).toBe("list_dir");
    expect(first_call?.args).toEqual({ path: "/x" });
    expect(first_call?.id).toMatch(/^ollama_/);
    expect(result.message.tool_calls?.length).toBe(1);
    expect(result.finish_reason).toBe("tool_calls");
    expect(result.usage).toEqual({ prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 });
    expect(result.model).toBe("llama3.2:latest");
    expect(result.provider_name).toBe("local-ollama");
  });

  it("maps done_reason stop with tool_calls to finish_reason tool_calls", async () => {
    const { fetch_fn } = mock_fetch(() => ({
      status: 200,
      body: ok_body({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "list_dir", arguments: { path: "/y" } } }],
        },
        done_reason: "stop",
      }),
    }));
    const provider = new OllamaProvider(ollama_config({ fetch_fn }));
    const result = await provider.chat([{ role: "user", content: "go" }], [SAMPLE_TOOL]);
    expect(result.finish_reason).toBe("tool_calls");
  });

  it("accepts tool arguments as a json string (proxy tolerance)", async () => {
    const { fetch_fn } = mock_fetch(() => ({
      status: 200,
      body: ok_body({
        message: {
          role: "assistant",
          content: "working",
          tool_calls: [{ function: { name: "list_dir", arguments: '{"path":"/z"}' } }],
        },
      }),
    }));
    const provider = new OllamaProvider(ollama_config({ fetch_fn }));
    const result = await provider.chat([{ role: "user", content: "go" }], [SAMPLE_TOOL]);
    expect(result.message.tool_calls?.[0]?.args).toEqual({ path: "/z" });
    expect(result.message.content).toBe("working");
  });

  it("omits executable tool calls on unparseable string arguments", async () => {
    const { fetch_fn } = mock_fetch(() => ({
      status: 200,
      body: ok_body({
        message: {
          role: "assistant",
          content: "trying",
          tool_calls: [{ function: { name: "list_dir", arguments: "{not json" } }],
        },
      }),
    }));
    const provider = new OllamaProvider(ollama_config({ fetch_fn }));
    const result = await provider.chat([{ role: "user", content: "go" }], [SAMPLE_TOOL]);
    expect(result.message.tool_calls).toBeUndefined();
    expect(result.message.content).toContain("[unparseable tool arguments]");
  });

  it("sends num_ctx from provider config in options", async () => {
    const { fetch_fn, requests } = mock_fetch(() => ({ status: 200, body: ok_body() }));
    const provider = new OllamaProvider(ollama_config({ fetch_fn, num_ctx: 100000 }));
    await provider.chat([{ role: "user", content: "hi" }], [], { temperature: 0.1, max_tokens: 64 });
    const body = request_json(requests[0]!);
    expect(as_record(body["options"])).toEqual({
      temperature: 0.1,
      num_predict: 64,
      num_ctx: 100000,
    });
  });

  it("defaults usage to zeros and unknown finish reasons", async () => {
    const { fetch_fn } = mock_fetch(() => ({ status: 200, body: ok_body({ prompt_eval_count: undefined, eval_count: undefined, done_reason: "weird" }) }));
    const provider = new OllamaProvider(ollama_config({ fetch_fn }));
    const result = await provider.chat([{ role: "user", content: "go" }], []);
    expect(result.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    expect(result.finish_reason).toBe("unknown");
  });

  it("maps length done_reasons to the length finish reason", async () => {
    const run_case = async (done_reason: string): Promise<string> => {
      const { fetch_fn } = mock_fetch(() => ({ status: 200, body: ok_body({ done_reason }) }));
      const provider = new OllamaProvider(ollama_config({ fetch_fn }));
      const result = await provider.chat([{ role: "user", content: "go" }], []);
      return result.finish_reason;
    };
    expect(await run_case("length")).toBe("length");
    expect(await run_case("max_tokens")).toBe("length");
    expect(await run_case("stop")).toBe("stop");
  });

  it("maps 400 context text to overflow and 429 to rate_limit with retry-after", async () => {
    const overflow_mock = mock_fetch(() => ({
      status: 400,
      text_body: "prompt too long: context length exceeded",
    }));
    const overflow_provider = new OllamaProvider(ollama_config({ fetch_fn: overflow_mock.fetch_fn }));
    const overflow_failure = await overflow_provider.chat([{ role: "user", content: "go" }], []).catch(
      (error: unknown) => error,
    );
    expect(overflow_failure).toBeInstanceOf(ProviderError);
    expect((overflow_failure as ProviderError).kind).toBe("overflow");

    const throttled_mock = mock_fetch(() => ({
      status: 429,
      body: { error: "slow down" },
      headers: { "retry-after": "2" },
    }));
    const throttled_provider = new OllamaProvider(ollama_config({ fetch_fn: throttled_mock.fetch_fn }));
    const throttled_failure = await throttled_provider.chat([{ role: "user", content: "go" }], []).catch(
      (error: unknown) => error,
    );
    const throttled_error = throttled_failure as ProviderError;
    expect(throttled_error.kind).toBe("rate_limit");
    expect(throttled_error.retry_after_ms).toBe(2000);
    expect(throttled_error.status).toBe(429);
  });

  it("treats 5xx as transient rate_limit while preserving status", async () => {
    const { fetch_fn } = mock_fetch(() => ({ status: 500, text_body: "upstream unavailable" }));
    const provider = new OllamaProvider(ollama_config({ fetch_fn }));
    const failure = await provider.chat([{ role: "user", content: "go" }], []).catch((error: unknown) => error);
    const provider_error = failure as ProviderError;
    expect(provider_error.kind).toBe("rate_limit");
    expect(provider_error.status).toBe(500);
  });

  it("maps an error field in a 200 response to bad_request", async () => {
    const { fetch_fn } = mock_fetch(() => ({ status: 200, body: { error: "model 'nope' not found" } }));
    const provider = new OllamaProvider(ollama_config({ fetch_fn }));
    const failure = await provider.chat([{ role: "user", content: "go" }], []).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    const provider_error = failure as ProviderError;
    expect(provider_error.kind).toBe("bad_request");
    expect(provider_error.message).toContain("model 'nope' not found");
  });

  it("throws bad_request when a 200 response has no message", async () => {
    const { fetch_fn } = mock_fetch(() => ({ status: 200, body: ok_body({ message: undefined }) }));
    const provider = new OllamaProvider(ollama_config({ fetch_fn }));
    const failure = await provider.chat([{ role: "user", content: "go" }], []).catch((error: unknown) => error);
    const provider_error = failure as ProviderError;
    expect(provider_error.kind).toBe("bad_request");
  });

  it("passes an abort signal through to the underlying fetch", async () => {
    const { fetch_fn, requests } = mock_fetch(() => ({ status: 200, body: ok_body() }));
    const provider = new OllamaProvider(ollama_config({ fetch_fn, timeout_ms: 5000 }));
    await provider.chat([{ role: "user", content: "go" }], []);
    const [first_request] = requests;
    expect(first_request?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps a refused connection to a network error", async () => {
    const fetch_fn: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));
    const provider = new OllamaProvider(ollama_config({ fetch_fn }));
    const failure = await provider.chat([{ role: "user", content: "go" }], []).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).kind).toBe("network");
  });

  it("create_ollama_provider builds an OllamaProvider with config identity", () => {
    const provider = create_ollama_provider(ollama_config());
    expect(provider).toBeInstanceOf(OllamaProvider);
    expect(provider.name).toBe("local-ollama");
    expect(provider.model).toBe("llama3.2:latest");
  });
});

describe("ollama failover integration", () => {
  it("retries the ollama provider after a transient 500 then succeeds", async () => {
    let ollama_calls = 0;
    const ollama_mock = mock_fetch(() => {
      ollama_calls += 1;
      if (ollama_calls === 1) {
        return { status: 500, text_body: "transient ollama hiccup" };
      }
      return { status: 200, body: ok_body({ message: { role: "assistant", content: "recovered" } }) };
    });
    const openai_mock = mock_fetch(() => ({ status: 200, body: {
      model: "gpt-test",
      choices: [{ message: { role: "assistant", content: "backup says hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    } }));
    const router = new ProviderRouter([
      ollama_config({ name: "mock-ollama", fetch_fn: ollama_mock.fetch_fn }),
      { kind: "openai_compat", name: "mock-openai", model: "gpt-test", api_key: "sk-test", fetch_fn: openai_mock.fetch_fn },
    ]);
    const result = await chat_with_failover(router, [{ role: "user", content: "hi" }], []);
    expect(result.provider_name).toBe("mock-ollama");
    expect(result.message.content).toBe("recovered");
    expect(ollama_calls).toBe(2);
    expect(openai_mock.requests.length).toBe(0);
  });
});