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
import { Agent, create_agent_with_plugins } from "../src/agent/agent.js";
import { parse_agent_config } from "../src/agent/config.js";
import type { AgentConfig } from "../src/agent/config.js";
import type { Tool, ToolContext } from "../src/tools/types.js";
import type { BeforeToolCallResult, Plugin, PluginHooks } from "../src/plugins/types.js";

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

/** Fresh plugin object wrapping hooks: each call is a distinct WeakMap key. */
function plugin_with(hooks: PluginHooks): Plugin {
  return { name: "test_hooks", hooks };
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
    const hooked = new HookedToolRunner(runner, [plugin_with(blocker)]);
    const result = await hooked.execute("blocked_tool", {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("blocked_by_plugin: nope");
    expect(result.output).toBe("");
    expect(calls).toEqual([]);
  });

  it("passes non-blocking calls through and feeds after hooks a summary", async () => {
    const log: string[] = [];
    const { runner, calls } = spy_runner("tool output");
    const hooked = new HookedToolRunner(runner, [plugin_with(hook_recorder(log))]);
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
    const hooked = new HookedToolRunner(runner, [plugin_with(throwing)]);
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
    const hooked = new HookedToolRunner(runner, [plugin_with(watcher)]);
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
    const hooked = new HookedToolRunner(runner, [plugin_with(lifecycle)]);
    await hooked.call_run_start({ input_chars: 7 }, { work_dir: "/tmp" });
    await hooked.call_run_end({ stopped_reason: "final", turns_used: 3 }, { work_dir: "/tmp" });
    expect(marks).toEqual(["start", "end:final:3"]);
  });

  it("exposes structured ok/error fields to after hooks (A7)", async () => {
    const seen_ok: boolean[] = [];
    const seen_error: Array<string | undefined> = [];
    const { runner } = spy_runner("anything");
    const failing_runner: WrappedToolRunner = {
      execute: async () => ({ ok: false, output: "partial", error: "boom" }),
    };
    const watcher: PluginHooks = {
      after_tool_call: async (info) => {
        seen_ok.push(info.ok);
        seen_error.push(info.error);
      },
    };
    const hooked = new HookedToolRunner(runner, [plugin_with(watcher)]);
    await hooked.execute("read_file", {});
    const hooked_failing = new HookedToolRunner(failing_runner, [plugin_with(watcher)]);
    await hooked_failing.execute("read_file", {});
    expect(seen_ok).toEqual([true, false]);
    expect(seen_error).toEqual([undefined, "boom"]);
  });

  it("state ctx is per-plugin: hook sees only its own sub-map and probes find nothing (A8)", async () => {
    const seen_state: Array<Map<string, unknown> | undefined> = [];
    const probed: string[] = [];
    const spy: PluginHooks = {
      after_tool_call: async (_info, ctx) => {
        seen_state.push(ctx.state);
        if (ctx.state !== undefined) {
          ctx.state.set("owner", "spy");
        }
        for (const key of Object.getOwnPropertyNames(ctx)) {
          probed.push(`name:${key}`);
        }
        for (const sym of Object.getOwnPropertySymbols(ctx)) {
          probed.push(`symbol:${sym.toString()}`);
        }
      },
    };
    const other_spy: PluginHooks = {
      after_tool_call: async (_info, ctx) => {
        seen_state.push(ctx.state);
      },
    };
    const { runner } = spy_runner("ok");
    const hooked = new HookedToolRunner(runner, [plugin_with(spy), plugin_with(other_spy)]);
    await hooked.call_run_start({ input_chars: 1 }, { work_dir: "/tmp" });
    await hooked.execute("read_file", {});

    expect(seen_state).toHaveLength(2);
    expect(seen_state[0]).toBeDefined();
    expect(seen_state[1]).toBeDefined();
    expect(seen_state[0]).not.toBe(seen_state[1]);
    expect(seen_state[0]?.get("owner")).toBe("spy");
    expect(seen_state[1]?.get("owner")).toBeUndefined();
    // The channel is keyed on the plugin object inside the module, so the ctx
    // carries no enumerable symbol property a probe could walk.
    expect(probed.filter((entry) => entry.startsWith("symbol:"))).toEqual([]);
  });

  it("swaps fresh state per run: call_run_start resets every plugin's bag", async () => {
    const bags_at_start: Array<Map<string, unknown> | undefined> = [];
    const marker_from_prior_run: Array<boolean | undefined> = [];
    const stateful: PluginHooks = {
      on_run_start: async (_info, ctx) => {
        // Record whether a prior run's marker survived the fresh-bag swap.
        marker_from_prior_run.push(ctx.state?.get("marker") === true);
        bags_at_start.push(ctx.state);
        ctx.state?.set("marker", true);
      },
      after_tool_call: async (_info, ctx) => {
        ctx.state?.set("dirty", true);
      },
    };
    const { runner } = spy_runner("ok");
    const hooked = new HookedToolRunner(runner, [plugin_with(stateful)]);
    await hooked.call_run_start({ input_chars: 1 }, { work_dir: "/tmp" });
    await hooked.execute("read_file", {});
    await hooked.call_run_start({ input_chars: 1 }, { work_dir: "/tmp" });
    await hooked.execute("read_file", {});

    expect(bags_at_start).toHaveLength(2);
    expect(bags_at_start[0]).not.toBe(bags_at_start[1]);
    // Run 1 started from nothing; run 2's bag was swapped fresh before its
    // on_run_start fired, so run 1's marker did not leak across the reset.
    expect(marker_from_prior_run).toEqual([false, false]);
  });

  it("keeps concurrent run_scope bags isolated (M-6)", async () => {
    const seen: number[] = [];
    const hooks: PluginHooks = {
      on_run_start: async (_info, ctx) => {
        ctx.state?.set("commits", 0);
      },
      after_tool_call: async (_info, ctx) => {
        const next = (typeof ctx.state?.get("commits") === "number" ? (ctx.state.get("commits") as number) : 0) + 1;
        ctx.state?.set("commits", next);
        seen.push(next);
      },
    };
    const { runner } = spy_runner("ok");
    const hooked = new HookedToolRunner(runner, [plugin_with(hooks)]);
    await Promise.all([
      hooked.run_scope(async () => {
        await hooked.call_run_start({ input_chars: 1 }, { work_dir: "/tmp" });
        await hooked.execute("write_file", {});
        await new Promise((resolve) => setTimeout(resolve, 30));
        await hooked.execute("write_file", {});
      }),
      hooked.run_scope(async () => {
        await hooked.call_run_start({ input_chars: 1 }, { work_dir: "/tmp" });
        await hooked.execute("write_file", {});
      }),
    ]);
    // Each scope increments from its own zero; concurrent reset must not collapse to 3 in one bag.
    expect(seen.sort((a, b) => a - b)).toEqual([1, 1, 2]);
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
      agent_name: "lich",
      theme: "lich",
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
      agent_name: "lich",
      theme: "lich",
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

describe("per-run ToolContext plumbing", () => {
  interface SeenContext {
    work_dir: string;
    env: Record<string, string>;
  }

  /** Plugin whose tool records each ToolContext it is executed with. */
  function make_ctx_witness(seen: SeenContext[], hook_dirs: string[]): Plugin {
    const probe: Tool = {
      name: "ctx_probe",
      description: "Records the ToolContext of each execution.",
      parameters: { type: "object" },
      execute: async (_args, context) => {
        seen.push({ work_dir: context.work_dir, env: context.env });
        return { ok: true, output: "probed" };
      },
    };
    return {
      name: "ctx_witness",
      tools: [probe],
      hooks: {
        before_tool_call: async (_info, ctx) => {
          hook_dirs.push(ctx.work_dir);
        },
      },
    };
  }

  function scripted_probe_fetch(): { fetch_fn: typeof fetch; count: () => number } {
    return scripted_fetch((call_count) => {
      if (call_count <= 2) {
        return completion_body(tool_call_body(`t${call_count}`, "ctx_probe", {}), "tool_calls");
      }
      return completion_body({ role: "assistant", content: "done" }, "stop");
    });
  }

  it("builds one ToolContext per run: every tool call shares the same env map (A6)", async () => {
    const work_dir = await make_temp_dir();
    const seen: SeenContext[] = [];
    const hook_dirs: string[] = [];
    const fetch_script = scripted_probe_fetch();
    const raw = base_config(work_dir, fetch_script.fetch_fn);
    raw["terminal_timeout_ms"] = 12345;
    process.env["LICH_TEST_COMMAND"] = "bun test";
    try {
      const agent = new Agent(parse_agent_config(raw), [{ plugin: make_ctx_witness(seen, hook_dirs), entry: "ctx_witness" }]);
      await agent.run({ input: "probe twice" });
    } finally {
      delete process.env["LICH_TEST_COMMAND"];
    }

    expect(seen).toHaveLength(2);
    expect(seen[0]?.work_dir).toBe(work_dir);
    expect(seen[0]?.env).toBe(seen[1]?.env);
    expect(seen[0]?.env["LICH_TERMINAL_TIMEOUT_MS"]).toBe("12345");
    expect(seen[0]?.env["LICH_TEST_COMMAND"]).toBe("bun test");
    // Hooks see the run's work_dir, not process.cwd() (the old two-site bug).
    expect(hook_dirs).toEqual([work_dir, work_dir]);
    expect(fetch_script.count()).toBe(3);
  });

  it("shares one state bag across the lifecycle and per-tool ctx build sites (A8)", async () => {
    const work_dir = await make_temp_dir();
    const seen: string[] = [];
    const stateful: Plugin = {
      name: "stateful",
      hooks: {
        on_run_start: async (_info, ctx) => {
          ctx.state?.set("seeded_at_run_start", "yes");
        },
        after_tool_call: async (_info, ctx) => {
          seen.push(String(ctx.state?.get("seeded_at_run_start")));
        },
      },
    };
    const fetch_script = scripted_fetch((call_count) => {
      if (call_count === 1) {
        return completion_body(tool_call_body("t1", "read_file", { path: "a.txt" }), "tool_calls");
      }
      return completion_body({ role: "assistant", content: "done" }, "stop");
    });
    const agent = new Agent(parse_agent_config(base_config(work_dir, fetch_script.fetch_fn)), [
      { plugin: stateful, entry: "stateful" },
    ]);
    await agent.run({ input: "go" });

    expect(seen).toEqual(["yes"]);
  });

  it("resets plugin state across two runs in one process", async () => {
    const work_dir = await make_temp_dir();
    const marks: string[] = [];
    const counter: Plugin = {
      name: "counter",
      hooks: {
        after_tool_call: async (_info, ctx) => {
          if (ctx.state?.get("seen_once") === true) {
            marks.push("stale");
            return;
          }
          ctx.state?.set("seen_once", true);
          marks.push("fresh");
        },
      },
    };
    const fetch_script = scripted_fetch((call_count) => {
      if (call_count % 2 === 1) {
        return completion_body(tool_call_body("t1", "read_file", { path: "a.txt" }), "tool_calls");
      }
      return completion_body({ role: "assistant", content: "done" }, "stop");
    });
    const agent = new Agent(parse_agent_config(base_config(work_dir, fetch_script.fetch_fn)), [
      { plugin: counter, entry: "counter" },
    ]);
    await agent.run({ input: "one" });
    await agent.run({ input: "two" });

    expect(marks).toEqual(["fresh", "fresh"]);
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