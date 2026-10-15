/**
 * #149 PR B: plugin entries with settings and granted model roles, host model
 * access on HookContext/ToolContext, and the before_llm_call hook.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { parse_agent_config } from "../src/agent/config.js";
import { NOTE_MAX_CHARS } from "../src/plugins/hooks.js";
import { load_plugins, type LoadedPlugin } from "../src/plugins/loader.js";
import type { HookContext, Plugin } from "../src/plugins/types.js";
import type { ToolContext } from "../src/tools/types.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/plugins/", import.meta.url));
const temp_dirs: string[] = [];

afterAll(async () => {
  for (const dir of temp_dirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function make_temp_dir(): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(path.join(TMP_BASE, "plugin-host-"));
  temp_dirs.push(dir);
  return dir;
}

interface SentMessage {
  role: string;
  content: string;
}

/** Provider fetch that records each request's messages and replies from a script. */
function recording_fetch(reply: (call: number) => Record<string, unknown>): {
  fetch_fn: typeof fetch;
  requests: SentMessage[][];
} {
  const requests: SentMessage[][] = [];
  const fetch_fn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: SentMessage[] };
    requests.push(body.messages);
    const message = reply(requests.length);
    const payload = {
      model: "m",
      choices: [{ message, finish_reason: message["tool_calls"] === undefined ? "stop" : "tool_calls" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  return { fetch_fn, requests };
}

function text(content: string): Record<string, unknown> {
  return { role: "assistant", content };
}

/** Hangs until `signal` aborts. The timer fails the test if cancel never arrives. */
function hang_until_abort(signal: AbortSignal | undefined, started: () => void, on_abort: () => void): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fetch was not aborted")), 400);
    const fail = (): void => {
      clearTimeout(timer);
      on_abort();
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (signal?.aborted === true) {
      fail();
      return;
    }
    signal?.addEventListener("abort", fail, { once: true });
    started();
  });
}

function tool_call(name: string): Record<string, unknown> {
  return {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "t1", type: "function", function: { name, arguments: "{}" } }],
  };
}

async function make_agent(
  fetch_fn: typeof fetch,
  loaded: LoadedPlugin[],
  extra: Record<string, unknown> = {},
): Promise<Agent> {
  const work_dir = await make_temp_dir();
  const config = parse_agent_config({
    providers: [{ kind: "openai_compat", name: "mock", model: "m", api_key: "k", base_url: "http://mock.local/v1", fetch_fn }],
    work_dir,
    session_dir: path.join(work_dir, "sessions"),
    log_level: "error",
    ...extra,
  });
  return new Agent(config, loaded);
}

describe("plugin entries in config", () => {
  it("accepts bare paths and objects, deep-freezing settings", () => {
    const config = parse_agent_config({
      providers: [{ kind: "openai_compat", name: "a", model: "m" }],
      plugins: ["./bare.mjs", { path: "./lane.mjs", settings: { mode: "shadow", nested: { k: 1 } }, models: ["compress"] }],
    });
    const entry = config.plugins[1];
    expect(typeof entry).toBe("object");
    if (typeof entry === "object") {
      expect(Object.isFrozen(entry.settings)).toBe(true);
      expect(Object.isFrozen(entry.settings?.["nested"])).toBe(true);
      expect(entry.models).toEqual(["compress"]);
    }
  });

  it("rejects unknown roles and unknown keys", () => {
    const providers = [{ kind: "openai_compat", name: "a", model: "m" }];
    expect(() => parse_agent_config({ providers, plugins: [{ path: "./p.mjs", models: ["embed"] }] })).toThrow();
    expect(() => parse_agent_config({ providers, plugins: [{ path: "./p.mjs", optoins: {} }] })).toThrow();
  });

  it("loader carries settings and roles for object entries only", async () => {
    const { plugins, errors } = await load_plugins(
      ["good.plugin.ts", { path: "named.plugin.ts", settings: { threshold: 0.75 }, models: ["chat"] }],
      FIXTURES,
    );
    expect(errors).toEqual([]);
    expect(plugins[0]?.settings).toBeUndefined();
    expect(plugins[0]?.models).toBeUndefined();
    expect(plugins[1]?.entry).toBe("named.plugin.ts");
    expect(plugins[1]?.settings).toEqual({ threshold: 0.75 });
    expect(Object.isFrozen(plugins[1]?.settings)).toBe(true);
    expect(plugins[1]?.models).toEqual(["chat"]);
  });

  it("loader deep-freezes a copy of object-entry settings", async () => {
    const nested = { level: 1 };
    const { plugins } = await load_plugins([{ path: "named.plugin.ts", settings: { nested } }], FIXTURES);
    const settings = plugins[0]?.settings as { nested: { level: number } };
    expect(Object.isFrozen(settings.nested)).toBe(true);
    expect(Object.isFrozen(nested)).toBe(false);
  });
});

describe("plugin settings and model access", () => {
  it("hands hooks frozen settings and refuses ungranted roles", async () => {
    const seen: HookContext[] = [];
    const errors: string[] = [];
    const plugin: Plugin = {
      name: "lane",
      hooks: {
        on_run_start: async (_info, ctx) => {
          seen.push(ctx);
          await ctx.models?.chat("chat", [{ role: "user", content: "x" }]).catch((error: Error) => {
            errors.push(error.message);
          });
        },
      },
    };
    const { fetch_fn } = recording_fetch(() => text("done"));
    const agent = await make_agent(fetch_fn, [{ plugin, entry: "lane", settings: Object.freeze({ mode: "shadow" }) }]);
    await agent.run({ input: "go" });
    expect(seen[0]?.settings).toEqual({ mode: "shadow" });
    expect(Object.isFrozen(seen[0]?.settings)).toBe(true);
    expect(errors).toEqual(['plugin "lane" was not granted model role "chat"']);
  });

  it("lets a granted role call the host chain, compress falling back to chat", async () => {
    const answers: string[] = [];
    const plugin: Plugin = {
      name: "lane",
      hooks: {
        on_run_start: async (_info, ctx) => {
          const result = await ctx.models?.chat("compress", [{ role: "user", content: "classify" }]);
          answers.push(result?.message.content ?? "");
        },
      },
    };
    const { fetch_fn, requests } = recording_fetch((call) => text(call === 1 ? "side answer" : "done"));
    const agent = await make_agent(fetch_fn, [{ plugin, entry: "lane", models: ["compress"] }]);
    await agent.run({ input: "go" });
    expect(answers).toEqual(["side answer"]);
    expect(requests[0]?.at(-1)?.content).toBe("classify");
  });

  it("gives plugin tools their own settings and model access", async () => {
    const contexts: ToolContext[] = [];
    const plugin: Plugin = {
      name: "lane",
      tools: [
        {
          name: "lane_probe",
          description: "probe",
          parameters: { type: "object", properties: {} },
          execute: async (_args, context) => {
            contexts.push(context);
            return { ok: true, output: "probed" };
          },
        },
      ],
    };
    const { fetch_fn } = recording_fetch((call) => (call === 1 ? tool_call("lane_probe") : text("done")));
    const agent = await make_agent(fetch_fn, [{ plugin, entry: "lane", settings: Object.freeze({ k: "v" }) }]);
    await agent.run({ input: "go" });
    expect(contexts[0]?.settings).toEqual({ k: "v" });
    expect(typeof contexts[0]?.models?.chat).toBe("function");
    expect(contexts[0]?.work_dir.length).toBeGreaterThan(0);
  });
});

describe("before_llm_call", () => {
  it("adds a capped note to that one call and never to the history", async () => {
    let calls = 0;
    const plugin: Plugin = {
      name: "lane",
      hooks: {
        before_llm_call: (info) => {
          calls += 1;
          expect(info.messages.some((message) => message.role === "user")).toBe(true);
          return calls === 1 ? { note: "y".repeat(NOTE_MAX_CHARS + 50) } : undefined;
        },
      },
    };
    const { fetch_fn, requests } = recording_fetch((call) => (call === 1 ? tool_call("read_file") : text("done")));
    const agent = await make_agent(fetch_fn, [{ plugin, entry: "lane" }]);
    const run = await agent.run({ input: "go" });
    const first_note = requests[0]?.at(-1);
    expect(first_note?.role).toBe("system");
    expect(first_note?.content).toBe(`[plugin lane] ${"y".repeat(NOTE_MAX_CHARS)}`);
    expect(requests[1]?.some((message) => message.content.startsWith("[plugin lane]"))).toBe(false);
    expect(run.messages.some((message) => message.content?.startsWith("[plugin lane]") === true)).toBe(false);
  });

  it("hands hooks a deep copy, so mutations never reach history", async () => {
    const plugin: Plugin = {
      name: "lane",
      hooks: {
        before_llm_call: (info) => {
          const first = info.messages.find((message) => message.role === "user") as { content: string };
          first.content = "tampered";
        },
      },
    };
    const { fetch_fn, requests } = recording_fetch(() => text("done"));
    const agent = await make_agent(fetch_fn, [{ plugin, entry: "lane" }]);
    const run = await agent.run({ input: "go" });
    expect(run.messages.some((message) => message.content === "tampered")).toBe(false);
    expect(requests[0]?.some((message) => message.content === "tampered")).toBe(false);
  });

  it("aborts plugin model calls with the run signal", async () => {
    const controller = new AbortController();
    const seen: boolean[] = [];
    let rejected = 0;
    const plugin: Plugin = {
      name: "lane",
      hooks: {
        before_llm_call: async (_info, ctx) => {
          controller.abort();
          await ctx.models?.chat("chat", [{ role: "user", content: "x" }]).catch(() => {
            rejected += 1;
          });
        },
      },
    };
    const fetch_fn: typeof fetch = async (_url, init) => {
      seen.push(init?.signal?.aborted === true);
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };
    const agent = await make_agent(fetch_fn, [{ plugin, entry: "lane", models: ["chat"] }]);
    await agent.run({ input: "go", signal: controller.signal });
    expect(rejected).toBe(1);
    // The router refuses an already-aborted signal before any request goes out.
    expect(seen).toEqual([]);
  });

  it("aborts an in-flight plugin model call when the run is aborted", async () => {
    const controller = new AbortController();
    let saw_abort = false;
    let started!: () => void;
    const started_gate = new Promise<void>((resolve) => {
      started = resolve;
    });
    const plugin: Plugin = {
      name: "lane",
      hooks: {
        before_llm_call: async (_info, ctx) => {
          const pending = ctx.models?.chat("chat", [{ role: "user", content: "side" }]);
          await started_gate;
          controller.abort();
          await pending?.catch(() => undefined);
        },
      },
    };
    const fetch_fn: typeof fetch = (_url, init) => hang_until_abort(init?.signal ?? undefined, started, () => {
      saw_abort = true;
    });
    const agent = await make_agent(fetch_fn, [{ plugin, entry: "lane", models: ["chat"] }]);
    const run = await agent.run({ input: "go", signal: controller.signal });
    expect(saw_abort).toBe(true);
    expect(run.outcome.stopped_reason).toBe("aborted");
  });

  it("cancels a plugin model call on its own signal and still finishes the run", async () => {
    const plugin_abort = new AbortController();
    let saw_abort = false;
    let started!: () => void;
    const started_gate = new Promise<void>((resolve) => {
      started = resolve;
    });
    const plugin: Plugin = {
      name: "lane",
      hooks: {
        before_llm_call: async (_info, ctx) => {
          const pending = ctx.models?.chat(
            "chat",
            [{ role: "user", content: "side" }],
            { signal: plugin_abort.signal },
          );
          await started_gate;
          plugin_abort.abort();
          await pending?.catch(() => undefined);
        },
      },
    };
    const fetch_fn: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content?: string }> };
      const side = body.messages.some((message) => message.content === "side");
      if (side === true) {
        return hang_until_abort(init?.signal ?? undefined, started, () => {
          saw_abort = true;
        });
      }
      const payload = {
        model: "m",
        choices: [{ message: text("done"), finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      return new Response(JSON.stringify(payload), { status: 200 });
    };
    const agent = await make_agent(fetch_fn, [{ plugin, entry: "lane", models: ["chat"] }]);
    const run = await agent.run({ input: "go" });
    expect(saw_abort).toBe(true);
    expect(run.outcome.stopped_reason).toBe("final");
    expect(run.outcome.final?.content).toBe("done");
  });

  it("fails open when the hook throws", async () => {
    const plugin: Plugin = {
      name: "lane",
      hooks: {
        before_llm_call: () => {
          throw new Error("decision model down");
        },
      },
    };
    const { fetch_fn, requests } = recording_fetch(() => text("done"));
    const agent = await make_agent(fetch_fn, [{ plugin, entry: "lane" }]);
    const run = await agent.run({ input: "go" });
    expect(run.outcome.final?.content).toBe("done");
    expect(requests[0]?.at(-1)?.role).toBe("user");
  });
});
