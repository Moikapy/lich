/**
 * Plugin system tests: loader shapes, error isolation, HookedToolRunner
 * interception semantics, and a full Agent run using a plugin tool.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { load_plugins, plugin_errors_summary } from "../src/plugins/loader.js";
import { HookedToolRunner, type WrappedToolRunner } from "../src/plugins/hooks.js";
import type { BeforeToolCallResult, Plugin, PluginHooks } from "../src/plugins/types.js";
import type { ToolContext } from "../src/tools/types.js";
import { create_agent_with_plugins } from "../src/agent/agent.js";
import type { AgentConfig } from "../src/agent/config.js";

const TEST_TMP_ROOT = fileURLToPath(new URL("./.tmp/", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/plugins/", import.meta.url));

const temp_dirs: string[] = [];

afterAll(async () => {
  for (const dir of temp_dirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function make_temp_dir(): Promise<string> {
  const dir = await mkdtemp(path.join(TEST_TMP_ROOT, "plugins-"));
  temp_dirs.push(dir);
  return dir;
}

interface SpyCall {
  name: string;
  args: Record<string, unknown>;
}

function spy_runner(output: string): { runner: WrappedToolRunner; calls: SpyCall[] } {
  const calls: SpyCall[] = [];
  const runner: WrappedToolRunner = {
    execute: async (name, args) => {
      calls.push({ name, args });
      return { ok: true, output };
    },
  };
  return { runner, calls };
}

function hook_recorder(log: string[]): PluginHooks {
  return {
    before_tool_call: async (info): Promise<BeforeToolCallResult | void> => {
      log.push(`before:${info.tool_name}`);
    },
    after_tool_call: async (info): Promise<void> => {
      log.push(`after:${info.tool_name}:${info.result_summary}`);
    },
  };
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

function scripted_fetch(script: (call_count: number) => unknown): { fetch_fn: typeof fetch; count: () => number } {
  let calls = 0;
  const fetch_fn: typeof fetch = () => {
    calls += 1;
    const body = script(calls);
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  };
  return { fetch_fn, count: () => calls };
}

function base_config(work_dir: string, fetch_fn: typeof fetch): Record<string, unknown> {
  return {
    providers: [{ kind: "openai_compat", name: "mock", model: "mock-model", base_url: "http://mock.local/v1", fetch_fn }],
    work_dir,
    session_dir: path.join(work_dir, "sessions"),
    log_level: "error",
  };
}

describe("load_plugins", () => {
  it("loads a default-export plugin and reports a missing entry as an error", async () => {
    const { plugins, errors } = await load_plugins(
      ["good.plugin.ts", "./does-not-exist.plugin.ts"],
      FIXTURES,
    );
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.plugin.name).toBe("good");
    expect(plugins[0]?.entry).toBe("good.plugin.ts");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.entry).toBe("./does-not-exist.plugin.ts");
    expect(errors[0]?.error_message.length).toBeGreaterThan(0);
  });

  it("accepts the named-export and module-itself shapes", async () => {
    const { plugins, errors } = await load_plugins(["named.plugin.ts", "module.plugin.ts"], FIXTURES);
    expect(errors).toEqual([]);
    expect(plugins.map((loaded) => loaded.plugin.name)).toEqual(["named", "module"]);
  });

  it("collapses duplicate plugin names into an error entry", async () => {
    const { plugins, errors } = await load_plugins(["good.plugin.ts", "good.plugin.ts"], FIXTURES);
    expect(plugins).toHaveLength(1);
    expect(errors).toEqual([{ entry: "good.plugin.ts", error_message: "duplicate_plugin_name: good" }]);
  });

  it("collects a module with no plugin export as an error, skipping empty entries", async () => {
    const no_export = path.join(FIXTURES, "no_export.plugin.ts");
    await writeFile(no_export, "export const not_a_plugin = true;\n", "utf8");
    temp_dirs.push(no_export);
    const { plugins, errors } = await load_plugins(["", no_export], FIXTURES);
    expect(plugins).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(plugin_errors_summary(errors)).toContain("no_export.plugin.ts");
    await rm(no_export, { force: true });
  });
});

describe("HookedToolRunner", () => {
  it("blocks before hooks without calling the wrapped runner", async () => {
    const { runner, calls } = spy_runner("untouched");
    const blocker: PluginHooks = {
      before_tool_call: async () => ({ block: true, reason: "nope" }),
    };
    const hooked = new HookedToolRunner(runner, [blocker]);
    const result = await hooked.execute("blocked_tool", {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("blocked_by_plugin: nope");
    expect(result.output).toBe("");
    expect(calls).toEqual([]);
  });

  it("passes non-blocking calls through and feeds after hooks a summary", async () => {
    const log: string[] = [];
    const { runner, calls } = spy_runner("tool output");
    const hooked = new HookedToolRunner(runner, [hook_recorder(log)]);
    const result = await hooked.execute("read_file", { path: "a.txt" });
    expect(result).toEqual({ ok: true, output: "tool output" });
    expect(calls).toEqual([{ name: "read_file", args: { path: "a.txt" } }]);
    expect(log).toEqual(["before:read_file", "after:read_file:tool output"]);
  });

  it("continues when a hook throws", async () => {
    const { runner, calls } = spy_runner("still works");
    const throwing: PluginHooks = {
      before_tool_call: async () => {
        throw new Error("hook blew up");
      },
      after_tool_call: async () => {
        throw new Error("hook blew up");
      },
    };
    const hooked = new HookedToolRunner(runner, [throwing]);
    const result = await hooked.execute("read_file", {});
    expect(result.ok).toBe(true);
    expect(result.output).toBe("still works");
    expect(calls).toEqual([{ name: "read_file", args: {} }]);
  });

  it("truncates result summaries over 300 chars", async () => {
    const seen: string[] = [];
    const { runner } = spy_runner("x".repeat(400));
    const watcher: PluginHooks = {
      after_tool_call: async (info) => {
        seen.push(info.result_summary);
      },
    };
    const hooked = new HookedToolRunner(runner, [watcher]);
    await hooked.execute("read_file", {});
    expect(seen[0]?.length).toBe(300);
  });

  it("calls run lifecycle helpers for every registered hook", async () => {
    const marks: string[] = [];
    const lifecycle: PluginHooks = {
      on_run_start: async () => {
        marks.push("start");
      },
      on_run_end: async (info) => {
        marks.push(`end:${info.stopped_reason}:${info.turns_used}`);
      },
    };
    const { runner } = spy_runner("unused");
    const hooked = new HookedToolRunner(runner, [lifecycle]);
    await hooked.call_run_start({ input_chars: 7 }, { work_dir: "/tmp" });
    await hooked.call_run_end({ stopped_reason: "final", turns_used: 3 }, { work_dir: "/tmp" });
    expect(marks).toEqual(["start", "end:final:3"]);
  });
});

describe("Agent with plugins", () => {
  it("registers a plugin tool and the loop can call it end to end", async () => {
    const work_dir = await make_temp_dir();
    const fetch_script = scripted_fetch((call_count) => {
      if (call_count === 1) {
        return completion_body(tool_call_body("t1", "plugin_echo", { text: "hello" }), "tool_calls");
      }
      return completion_body({ role: "assistant", content: "echoed hello" }, "stop");
    });
    const config: AgentConfig = {
      providers: [{ kind: "openai_compat", name: "mock", model: "mock-model", base_url: "http://mock.local/v1", fetch_fn: fetch_script.fetch_fn }],
      work_dir,
      session_dir: path.join(work_dir, "sessions"),
      max_turns: 5,
      tools_enabled: "all",
      context_budget_tokens: 100000,
      compress_threshold: 0.8,
      terminal_timeout_ms: 60000,
      log_level: "error",
      plugins: [path.join(FIXTURES, "good.plugin.ts")],
    };
    const agent = await create_agent_with_plugins(config);
    const result = await agent.run({ input: "use plugin_echo to say hello" });

    expect(result.outcome.stopped_reason).toBe("final");
    const tool_message = result.messages.find((message) => message.role === "tool");
    expect(tool_message?.role === "tool" && tool_message.name).toBe("plugin_echo");
    expect(tool_message?.role === "tool" && tool_message.content).toBe("plugin_echo: hello");
    expect(fetch_script.count()).toBe(2);
  });

  it("blocks a tool via the plugin hook and reports the error to the model", async () => {
    const work_dir = await make_temp_dir();
    const fetch_script = scripted_fetch((call_count) => {
      if (call_count === 1) {
        return completion_body(tool_call_body("t1", "blocked_tool", {}), "tool_calls");
      }
      return completion_body({ role: "assistant", content: "was blocked" }, "stop");
    });
    const config: AgentConfig = {
      providers: [{ kind: "openai_compat", name: "mock", model: "mock-model", base_url: "http://mock.local/v1", fetch_fn: fetch_script.fetch_fn }],
      work_dir,
      session_dir: path.join(work_dir, "sessions"),
      max_turns: 5,
      tools_enabled: "all",
      context_budget_tokens: 100000,
      compress_threshold: 0.8,
      terminal_timeout_ms: 60000,
      log_level: "error",
      plugins: [path.join(FIXTURES, "good.plugin.ts")],
    };
    const agent = await create_agent_with_plugins(config);
    const result = await agent.run({ input: "call blocked_tool" });

    const tool_message = result.messages.find((message) => message.role === "tool");
    expect(tool_message?.role === "tool" && tool_message.content).toContain("blocked_by_plugin: nope");
    expect(fetch_script.count()).toBe(2);
  });
});

describe("Plugin type smoke", () => {
  it("accepts a hooks-only plugin object", () => {
    const hooks_only: Plugin = { name: "watcher" };
    expect(hooks_only.name).toBe("watcher");
  });

  it("ignores tool context signals in hook context", async () => {
    const context: ToolContext = { work_dir: "/w", env: {} };
    expect(context.work_dir).toBe("/w");
  });
});