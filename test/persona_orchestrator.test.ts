/**
 * Persona orchestrator: mock provider, webhook-shaped HTTP, no model network.
 * Sessions and game files stay under test/.tmp.
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { create_agent_with_plugins } from "../src/agent/agent.js";
import { create_orchestrator } from "../examples/persona_orchestrator/orchestrator.js";
import { persona_by_id, PERSONA_TABLE } from "../examples/persona_orchestrator/personas.js";
import { reply_text, round_fate } from "../examples/persona_orchestrator/reply.js";
import { DEFAULT_MAX_BODY_BYTES, host_is_loopback, start_persona_server } from "../examples/persona_orchestrator/server.js";
import type { AgentFactory, AgentLikeResult, PersonaEntry, SharedAgentDefaults } from "../examples/persona_orchestrator/types.js";
import { cap_history, enqueue } from "../examples/persona_orchestrator/history_queue.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN = path.join(REPO, "examples/game_bridge/game_bridge.plugin.mjs");
const BUILTIN_NAMES = [
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "terminal",
  "grep_files",
  "fetch_url",
  "web_search",
  "http_request",
  "process_list",
  "disk_usage",
  "env_get",
  "run_tests",
  "docs_read",
  "docs_search",
];

const temp_dirs: string[] = [];

afterAll(async () => {
  for (const dir of temp_dirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function make_temp_dir(): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(path.join(TMP_BASE, "persona-orch-"));
  temp_dirs.push(dir);
  return dir;
}

function factory_with(fetch_fn: typeof fetch, work_dir: string): { factory: AgentFactory; bodies: () => unknown[] } {
  const seen: unknown[] = [];
  const recording: typeof fetch = (_input, init) => {
    seen.push(JSON.parse(String(init?.body ?? "{}")));
    return fetch_fn(_input, init);
  };
  const factory = ((raw: unknown) => {
    const config = raw as { providers?: Array<Record<string, unknown>> };
    const providers = (config.providers ?? []).map((provider) => ({ ...provider, fetch_fn: recording }));
    return create_agent_with_plugins({ ...config, providers }) as unknown as ReturnType<AgentFactory>;
  }) as AgentFactory;
  return { factory, bodies: () => seen };
}

function stop_body(content: string) {
  return {
    model: "mock-model",
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  };
}

function shared_for(work_dir: string): SharedAgentDefaults {
  return {
    providers: [{ kind: "openai_compat", name: "mock", model: "mock-model", base_url: "http://mock.local/v1" }],
    work_dir,
    session_dir: path.join(work_dir, "sessions"),
    log_level: "error",
  };
}

function personas_for(): PersonaEntry[] {
  const commander = persona_by_id(PERSONA_TABLE, "commander");
  const chronicler = persona_by_id(PERSONA_TABLE, "chronicler");
  if (commander === undefined || chronicler === undefined) {
    throw new Error("persona table missing an entry");
  }
  return [{ ...commander, plugins: [PLUGIN] }, chronicler];
}

async function until_equal(actual: () => readonly string[], expected: readonly string[]): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (actual().join("|") === expected.join("|")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${expected.join("|")}, saw ${actual().join("|")}`);
}

function tool_names(body: unknown): string[] {
  const tools = (body as { tools?: Array<{ function?: { name?: string } }> }).tools ?? [];
  return tools.map((tool) => tool.function?.name ?? "");
}

function system_prompt_of(body: unknown): string | undefined {
  const messages = (body as { messages?: Array<{ role?: string; content?: string }> }).messages ?? [];
  return messages.find((message) => message.role === "system")?.content;
}

describe("persona orchestrator", () => {
  it("sends each persona system prompt and strips builtins on the empty allowlist", async () => {
    const work_dir = await make_temp_dir();
    const { factory, bodies } = factory_with(() => Promise.resolve(new Response(JSON.stringify(stop_body("ok")), { status: 200 })), work_dir);
    const orchestrator = create_orchestrator({
      factory,
      shared: shared_for(work_dir),
      personas: personas_for(),
    });
    await orchestrator.handle("webhook", "npc:commander:run-1", "hold the line");
    await orchestrator.handle("webhook", "npc:chronicler:run-1", "what is the keep");
    const seen = bodies();
    expect(system_prompt_of(seen[0])).toBe(persona_by_id(PERSONA_TABLE, "commander")?.system_prompt);
    expect(system_prompt_of(seen[1])).toBe(persona_by_id(PERSONA_TABLE, "chronicler")?.system_prompt);
    const commander_tools = tool_names(seen[0]);
    expect(commander_tools.filter((name) => BUILTIN_NAMES.includes(name))).toEqual([]);
    expect(commander_tools).toEqual(
      expect.arrayContaining(["enemy_actions", "dungeon_memory_read", "dungeon_memory_write", "git_commit"]),
    );
    const chronicler_tools = tool_names(seen[1]);
    expect(chronicler_tools).toContain("read_file");
    expect(chronicler_tools).not.toContain("terminal");
    expect(chronicler_tools).not.toContain("enemy_actions");
  });

  it("serializes concurrent posts to one chat_id", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory: AgentFactory = async () => ({
      run: async (options) => {
        order.push(`start:${options.input}`);
        if (options.input === "first") {
          await gate;
        }
        order.push(`end:${options.input}`);
        return echo_result(options.input, options.history ?? []);
      },
    });
    const orchestrator = create_orchestrator({
      factory,
      shared: shared_for(await make_temp_dir()),
      personas: PERSONA_TABLE,
    });
    const first = orchestrator.handle("webhook", "npc:commander:run-1", "first");
    await until_equal(() => order, ["start:first"]);
    const second = orchestrator.handle("webhook", "npc:commander:run-1", "second");
    await until_equal(() => order, ["start:first"]);
    release();
    const done = await Promise.all([first, second]);
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
    expect(done[1]?.reply).toBe("second");
  });

  it("serves POST /message as {reply, usage} and does not invent an attack on budget", async () => {
    const work_dir = await make_temp_dir();
    const fetch_fn: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            model: "mock-model",
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "t1",
                      type: "function",
                      function: {
                        name: "enemy_actions",
                        arguments: JSON.stringify({
                          round: 1,
                          actions: [{ enemy_id: "goblin", action: "meteor", target_ref: "hero:hero1" }],
                          rationale: "too early",
                        }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200 },
        ),
      );
    const commander = persona_by_id(PERSONA_TABLE, "commander");
    if (commander === undefined) {
      throw new Error("missing commander");
    }
    const { factory } = factory_with(fetch_fn, work_dir);
    const orchestrator = create_orchestrator({
      factory,
      shared: shared_for(work_dir),
      personas: [{ ...commander, max_turns: 1, plugins: [PLUGIN] }],
    });
    const server = await start_persona_server({ orchestrator, token: "sekrit" });
    try {
      const denied = await fetch(`http://127.0.0.1:${server.port}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "round 1", chat_id: "npc:commander:run-1" }),
      });
      expect(denied.status).toBe(401);
      const missing = await fetch(`http://127.0.0.1:${server.port}/message`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-lich-token": "sekrit" },
        body: JSON.stringify({ chat_id: "npc:commander:run-1" }),
      });
      expect(missing.status).toBe(400);
      const unknown = await fetch(`http://127.0.0.1:${server.port}/message`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-lich-token": "sekrit" },
        body: JSON.stringify({ text: "hi", chat_id: "not-a-persona" }),
      });
      expect(unknown.status).toBe(200);
      const unknown_body = (await unknown.json()) as { reply: string; usage: null };
      expect(unknown_body.reply.startsWith("agent error:")).toBe(true);
      expect(unknown_body.usage).toBeNull();
      const message = await fetch(`http://127.0.0.1:${server.port}/message`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-lich-token": "sekrit" },
        body: JSON.stringify({ text: "round 1", chat_id: "npc:commander:run-1" }),
      });
      expect(message.status).toBe(200);
      const payload = (await message.json()) as { reply: string; usage: { total_tokens: number } | null };
      expect(payload.reply).toBe("");
      expect(payload.reply).not.toContain("attack");
      expect(payload.usage?.total_tokens).toBe(2);
      expect(round_fate("budget")).toBe("game_repo_decides");
      expect(reply_text("budget", undefined)).toBe("");
      const orders = path.join(work_dir, ".lich/game/orders.jsonl");
      await expect(readFile(orders, "utf8")).rejects.toThrow();
    } finally {
      await server.stop();
    }
  });

  it("keeps an enqueue chain ordered even when the first task rejects", async () => {
    const chains = new Map<string, Promise<void>>();
    const order: string[] = [];
    const first = enqueue(chains, "npc:commander:run-1", async () => {
      order.push("first");
      throw new Error("boom");
    });
    const second = enqueue(chains, "npc:commander:run-1", async () => {
      order.push("second");
      return "ok";
    });
    await expect(first).rejects.toThrow("boom");
    expect(await second).toBe("ok");
    expect(order).toEqual(["first", "second"]);
    await Promise.resolve();
    expect(chains.has("npc:commander:run-1")).toBe(false);
  });

  it("cap_history drops leading non-user turns after overflow", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1", tool_calls: [{ id: "t1" }] },
      { role: "tool", content: "ok" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ];
    const capped = cap_history(messages, 3);
    expect(capped[0]?.role).toBe("user");
    expect(capped.map((message) => message.content)).toEqual(["u2", "a2"]);
  });

  it("requires a token and rejects wrong content-type / oversized bodies", async () => {
    const work_dir = await make_temp_dir();
    const factory: AgentFactory = async () => ({
      run: async (options) => echo_result(options.input, options.history ?? []),
    });
    const orchestrator = create_orchestrator({
      factory,
      shared: shared_for(work_dir),
      personas: PERSONA_TABLE,
    });
    await expect(start_persona_server({ orchestrator, token: "   " })).rejects.toThrow(/non-empty token/);
    const server = await start_persona_server({ orchestrator, token: "sekrit", max_body_bytes: 64 });
    try {
      const plain = await fetch(`http://127.0.0.1:${server.port}/message`, {
        method: "POST",
        headers: { "content-type": "text/plain", "x-lich-token": "sekrit" },
        body: '{"text":"hi","chat_id":"npc:commander:run-1"}',
      });
      expect(plain.status).toBe(415);
      const huge = await fetch(`http://127.0.0.1:${server.port}/message`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-lich-token": "sekrit" },
        body: JSON.stringify({ text: "x".repeat(128), chat_id: "npc:commander:run-1" }),
      });
      expect(huge.status).toBe(413);
      expect(DEFAULT_MAX_BODY_BYTES).toBeGreaterThan(1000);
      expect(host_is_loopback("127.0.0.1:8090")).toBe(true);
      expect(host_is_loopback("localhost")).toBe(true);
      expect(host_is_loopback("[::1]:8090")).toBe(true);
      expect(host_is_loopback("evil.example")).toBe(false);
      expect(host_is_loopback(undefined)).toBe(false);
    } finally {
      await server.stop();
    }
  });
});

function echo_result(input: string, history: readonly unknown[]): AgentLikeResult {
  return {
    outcome: { stopped_reason: "final", final: { content: input } },
    messages: [...history, { role: "user", content: input }, { role: "assistant", content: input }],
    usage_total: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}
