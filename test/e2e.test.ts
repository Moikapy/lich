/**
 * Full-stack e2e tests through the public API: scripted wire-level provider,
 * real tool execution against a temp work_dir, real session persistence.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { run_agent, create_agent, type AgentRunResult } from "../src/agent/agent.js";
import type { AgentConfig } from "../src/agent/config.js";
import { parse_agent_config } from "../src/agent/config.js";
import type { AgentEvent } from "../src/agent/events.js";
import type { ProviderConfig } from "../src/providers/types.js";
import { read_session_messages } from "../src/session/store.js";

const TEST_TMP_ROOT = fileURLToPath(new URL("./.tmp/", import.meta.url));

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

interface MockReply {
  status: number;
  body: unknown;
}

const temp_dirs: string[] = [];

afterAll(async () => {
  for (const dir of temp_dirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function make_temp_dir(): Promise<string> {
  const dir = await mkdtemp(path.join(TEST_TMP_ROOT, "e2e-"));
  temp_dirs.push(dir);
  return dir;
}

function scripted_fetch(script: (call_count: number) => MockReply): {
  fetch_fn: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetch_fn: typeof fetch = (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    const reply = script(requests.length);
    return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status }));
  };
  return { fetch_fn, requests };
}

function completion_body(message: Record<string, unknown>, finish_reason: string, usage: Record<string, number>) {
  return { model: "mock-model", choices: [{ message, finish_reason }], usage };
}

function tool_call_body(call_id: string, name: string, args: Record<string, unknown>) {
  return {
    role: "assistant",
    content: "",
    tool_calls: [{ id: call_id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

function request_messages(request: CapturedRequest | undefined): Array<Record<string, unknown>> {
  expect(request).toBeDefined();
  const body_text = typeof request?.init.body === "string" ? request.init.body : "";
  const body = JSON.parse(body_text) as { messages?: unknown };
  expect(Array.isArray(body.messages)).toBe(true);
  return body.messages as Array<Record<string, unknown>>;
}

function base_config(work_dir: string, fetch_fn: typeof fetch): Record<string, unknown> {
  return {
    providers: [
      { kind: "openai_compat", name: "mock", model: "mock-model", base_url: "http://mock.local/v1", fetch_fn },
    ],
    work_dir,
    session_dir: path.join(work_dir, "sessions"),
  };
}

describe("e2e through the public api", () => {
  it("runs a scripted write_file conversation end to end", async () => {
    const work_dir = await make_temp_dir();
    const { fetch_fn, requests } = scripted_fetch((call_count) => {
      if (call_count === 1) {
        return {
          status: 200,
          body: completion_body(
            tool_call_body("t1", "write_file", { path: "e2e.txt", content: "hello lich" }),
            "tool_calls",
            { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          ),
        };
      }
      return {
        status: 200,
        body: completion_body({ role: "assistant", content: "done: wrote file" }, "stop", {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        }),
      };
    });
    const events: AgentEvent[] = [];
    const config = parse_agent_config(base_config(work_dir, fetch_fn));
    const agent = create_agent(config);
    const stop_collecting = agent.events.on((event) => events.push(event));
    let run_result;
    try {
      run_result = await agent.run({ input: "write e2e.txt containing hello lich then confirm" });
    } finally {
      stop_collecting();
    }

    expect(run_result.outcome.stopped_reason).toBe("final");
    expect(run_result.outcome.final?.content).toContain("done");
    expect(run_result.usage_total.total_tokens).toBeGreaterThanOrEqual(15);

    const written = await readFile(path.join(work_dir, "e2e.txt"), "utf8");
    expect(written).toBe("hello lich");

    const tool_call_ends = events.filter(
      (event) => event.type === "tool_call_end" && event.call.name === "write_file",
    );
    expect(tool_call_ends.length).toBeGreaterThan(0);
    const last_tool_end = tool_call_ends[tool_call_ends.length - 1];
    expect(last_tool_end?.type === "tool_call_end" && last_tool_end.result.ok).toBe(true);
    expect(events.some((event) => event.type === "final")).toBe(true);

    expect(run_result.session_path).toBeDefined();
    const session_messages = await read_session_messages(run_result.session_path as string);
    expect(session_messages.length).toBeGreaterThanOrEqual(3);
    const last_message = session_messages[session_messages.length - 1];
    expect(last_message?.role).toBe("assistant");
    expect(last_message?.role === "assistant" && last_message.content).toContain("done");

    const second_body_messages = request_messages(requests[1]);
    const tool_wire = second_body_messages.some(
      (message) => message["role"] === "tool" && message["tool_call_id"] === "t1",
    );
    expect(tool_wire).toBe(true);
  });

  it("reports unknown_tool on the wire when a tool is filtered out", async () => {
    const work_dir = await make_temp_dir();
    const { fetch_fn, requests } = scripted_fetch((call_count) => {
      if (call_count === 1) {
        return {
          status: 200,
          body: completion_body(
            tool_call_body("t9", "write_file", { path: "blocked.txt", content: "nope" }),
            "tool_calls",
            { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          ),
        };
      }
      return {
        status: 200,
        body: completion_body({ role: "assistant", content: "done: skipped" }, "stop", {
          prompt_tokens: 5,
          completion_tokens: 3,
          total_tokens: 8,
        }),
      };
    });
    const raw = { ...base_config(work_dir, fetch_fn), tools_enabled: ["read_file"] };
    const config = parse_agent_config(raw) as AgentConfig;
    const agent = create_agent(config);
    const run_result = await agent.run({ input: "write blocked.txt then confirm" });

    expect(run_result.outcome.stopped_reason).toBe("final");
    const tool_messages = run_result.outcome.messages.filter((message) => message.role === "tool");
    expect(tool_messages.length).toBe(1);
    const tool_message = tool_messages[0];
    expect(tool_message?.role === "tool" && tool_message.is_error).toBe(true);
    expect(tool_message?.role === "tool" && tool_message.content).toContain("unknown_tool");

    const second_body_messages = request_messages(requests[1]);
    const error_wire = second_body_messages.some(
      (message) => message["role"] === "tool" && String(message["content"]).includes("unknown_tool"),
    );
    expect(error_wire).toBe(true);
    expect(await readFile(path.join(work_dir, "blocked.txt"), "utf8").catch(() => "absent")).toBe("absent");
  });

  it("run_agent convenience returns a persisted session path", async () => {
    const work_dir = await make_temp_dir();
    const { fetch_fn } = scripted_fetch(() => ({
      status: 200,
      body: completion_body({ role: "assistant", content: "done: immediate" }, "stop", {
        prompt_tokens: 4,
        completion_tokens: 2,
        total_tokens: 6,
      }),
    }));
    const raw = base_config(work_dir, fetch_fn);
    const result = await run_agent(raw, "say done", { label: "convenience" });
    expect(result.session_path).toBeDefined();
    expect(result.outcome.stopped_reason).toBe("final");
    expect(result.outcome.final?.content).toBe("done: immediate");
  });

  it("accepts a ProviderConfig-shaped provider list", () => {
    const provider: ProviderConfig = {
      kind: "openai_compat",
      name: "shape-check",
      model: "m",
      fetch_fn: (() => Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch,
    };
    expect(() => parse_agent_config({ providers: [provider] })).not.toThrow();
  });
});