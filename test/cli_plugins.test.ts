/**
 * CLI plugin loading: one-shot execution, chat/tui construction, gateway bus
 * reuse, and warn-and-continue for a missing entry. No network.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunResult } from "../src/agent/agent.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const ctor_spy = vi.hoisted(() => vi.fn());

vi.mock("../src/agent/agent.js", async (import_original) => {
  const actual = await import_original<typeof import("../src/agent/agent.js")>();
  ctor_spy.mockImplementation((raw_config: unknown) => actual.create_agent_with_plugins(raw_config));
  return { ...actual, create_agent_with_plugins: ctor_spy };
});

vi.mock("node:readline", () => {
  const createInterface = (): {
    question: (prompt: string, callback: (line: string) => void) => void;
    once: () => void;
    removeListener: () => void;
    close: () => void;
  } => ({
    question: (_prompt, callback) => {
      callback("");
    },
    once: () => undefined,
    removeListener: () => undefined,
    close: () => undefined,
  });
  return { createInterface, default: { createInterface } };
});

vi.mock("ink", () => ({
  render: () => ({ waitUntilExit: () => Promise.resolve() }),
}));

import { Agent } from "../src/agent/agent.js";
import { parse_agent_config } from "../src/agent/config.js";
import { run_agent } from "../src/agent/agent.js";
import { run_chat, run_one_shot } from "../src/cli.js";
import { create_gateway_bus } from "../src/gateway/runner.js";
import { run_tui } from "../src/tui.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/plugins/good.plugin.ts", import.meta.url));
const temp_dirs: string[] = [];

afterAll(async () => {
  for (const dir of temp_dirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  ctor_spy.mockClear();
});

async function make_temp_dir(): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(path.join(TMP_BASE, "cli-plugins-"));
  temp_dirs.push(dir);
  return dir;
}

function completion_body(message: Record<string, unknown>, finish_reason: string) {
  return {
    model: "mock-model",
    choices: [{ message, finish_reason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function tool_call_body(call_id: string, name: string, args: Record<string, unknown>) {
  return {
    role: "assistant",
    content: "",
    tool_calls: [{ id: call_id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

function scripted_fetch(script: (call_count: number) => unknown): typeof fetch {
  let calls = 0;
  return () => {
    calls += 1;
    return Promise.resolve(new Response(JSON.stringify(script(calls)), { status: 200 }));
  };
}

function mock_config(work_dir: string, fetch_fn: typeof fetch, extra?: Record<string, unknown>) {
  return {
    providers: [{ kind: "openai_compat", name: "mock", model: "mock-model", base_url: "http://mock.local/v1", fetch_fn }],
    work_dir,
    session_dir: path.join(work_dir, "sessions"),
    max_turns: 5,
    log_level: "error",
    plugins: [FIXTURE],
    ...extra,
  };
}

function echo_then_stop(label: string): (call_count: number) => unknown {
  return (call_count) => {
    if (call_count % 2 === 1) {
      return completion_body(tool_call_body("t1", "plugin_echo", { text: label }), "tool_calls");
    }
    return completion_body({ role: "assistant", content: "done" }, "stop");
  };
}

function tool_content(result: AgentRunResult): string {
  const message = result.messages.find((item) => item.role === "tool");
  return message?.role === "tool" ? message.content : "";
}

function spy_stderr(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join(""), restore: () => spy.mockRestore() };
}

async function agent_from_spy(): Promise<Agent> {
  const created: unknown = await ctor_spy.mock.results[0]?.value;
  expect(created).toBeInstanceOf(Agent);
  if (created instanceof Agent === false) {
    throw new Error("spy did not wrap create_agent_with_plugins");
  }
  return created;
}

describe("cli plugin load", () => {
  it("runs a plugin tool from one-shot and reports ok on stderr", async () => {
    const work_dir = await make_temp_dir();
    const fetch_fn = scripted_fetch(echo_then_stop("ok"));
    const stderr = spy_stderr();
    try {
      const code = await run_one_shot(mock_config(work_dir, fetch_fn), "echo");
      expect(code).toBe(0);
      expect(stderr.text()).toContain("plugin_echo: ok");
    } finally {
      stderr.restore();
    }
  });

  it("loads the fixture plugin through run_agent", async () => {
    const work_dir = await make_temp_dir();
    const fetch_fn = scripted_fetch(echo_then_stop("hello"));
    const result = await run_agent(mock_config(work_dir, fetch_fn), "echo hello");
    expect(tool_content(result)).toBe("plugin_echo: hello");
  });

  it("constructs chat with the real create_agent_with_plugins", async () => {
    const work_dir = await make_temp_dir();
    const fetch_fn = scripted_fetch(echo_then_stop("hello"));
    const code = await run_chat(mock_config(work_dir, fetch_fn));
    expect(code).toBe(0);
    expect(ctor_spy).toHaveBeenCalledTimes(1);
    const agent = await agent_from_spy();
    expect(tool_content(await agent.run({ input: "echo" }))).toBe("plugin_echo: hello");
  });

  it("constructs the tui with the real create_agent_with_plugins", async () => {
    const work_dir = await make_temp_dir();
    const fetch_fn = scripted_fetch(echo_then_stop("hello"));
    const config = parse_agent_config(mock_config(work_dir, fetch_fn));
    const code = await run_tui(config);
    expect(code).toBe(0);
    expect(ctor_spy).toHaveBeenCalledTimes(1);
    const agent = await agent_from_spy();
    expect(tool_content(await agent.run({ input: "echo" }))).toBe("plugin_echo: hello");
  });

  it("reuses the preloaded gateway agent for tool_call_end", async () => {
    const work_dir = await make_temp_dir();
    let calls = 0;
    const fetch_fn = scripted_fetch(() => {
      calls += 1;
      return calls % 2 === 1
        ? completion_body(tool_call_body("t1", "plugin_echo", { text: calls === 1 ? "hello" : "bus" }), "tool_calls")
        : completion_body({ role: "assistant", content: "done" }, "stop");
    });
    const { agent, bus } = await create_gateway_bus(parse_agent_config(mock_config(work_dir, fetch_fn)));
    expect(tool_content(await agent.run({ input: "echo" }))).toBe("plugin_echo: hello");
    const ended: string[] = [];
    agent.events.on((event) => {
      if (event.type === "tool_call_end") {
        ended.push(event.call.name);
      }
    });
    await bus.handle("webhook", "c1", "u1", "echo on the bus");
    bus.stop();
    expect(ended).toEqual(["plugin_echo"]);
  });

  it("warns once for a missing plugin and still completes one-shot", async () => {
    const work_dir = await make_temp_dir();
    const fetch_fn = scripted_fetch(() => completion_body({ role: "assistant", content: "continued" }, "stop"));
    const errors: string[] = [];
    const console_spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });
    try {
      const code = await run_one_shot(
        mock_config(work_dir, fetch_fn, { plugins: ["./missing.plugin.ts"], log_level: "warn" }),
        "continue",
      );
      expect(code).toBe(0);
      expect(errors.filter((line) => line.includes("plugin load errors"))).toHaveLength(1);
    } finally {
      console_spy.mockRestore();
    }
  });
});
