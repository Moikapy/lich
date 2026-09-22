/**
 * game_bridge example: real load_plugins, file effects, meteor veto re-plan,
 * and a config.plugins run through the built dist CLI (node, no network).
 */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { create_agent_with_plugins } from "../src/agent/agent.js";
import { load_plugins } from "../src/plugins/loader.js";
import type { Plugin } from "../src/plugins/types.js";
import type { Tool, ToolContext } from "../src/tools/types.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_REL = "./examples/game_bridge/game_bridge.plugin.mjs";
const PLUGIN_ABS = path.join(REPO, "examples/game_bridge/game_bridge.plugin.mjs");
const CLI = path.join(REPO, "dist/cli.js");

const temp_dirs: string[] = [];

afterAll(async () => {
  for (const dir of temp_dirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function make_temp_dir(): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(path.join(TMP_BASE, "game-bridge-"));
  temp_dirs.push(dir);
  return dir;
}

async function load_game_bridge(): Promise<Plugin> {
  const { plugins, errors } = await load_plugins([PLUGIN_REL], REPO);
  expect(errors).toEqual([]);
  const plugin = plugins[0]?.plugin;
  expect(plugin?.name).toBe("game_bridge");
  if (plugin === undefined) {
    throw new Error("game_bridge did not load");
  }
  return plugin;
}

function require_tool(plugin: Plugin, name: string): Tool {
  const tool = plugin.tools?.find((item) => item.name === name);
  if (tool === undefined) {
    throw new Error(`missing tool ${name}`);
  }
  return tool;
}

function tool_context(work_dir: string): ToolContext {
  return { work_dir, env: {} };
}

function strike(round: number, action = "attack"): Record<string, unknown> {
  return {
    round,
    actions: [{ enemy_id: "goblin", action, target_ref: "hero:hero1" }],
    rationale: "open with a strike",
  };
}

function completion_body(message: Record<string, unknown>, finish_reason: string) {
  return {
    model: "mock-model",
    choices: [{ message, finish_reason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function tool_call_body(name: string, args: Record<string, unknown>) {
  return {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "t1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

function scripted_fetch(script: (call_count: number) => unknown): { fetch_fn: typeof fetch; count: () => number } {
  let calls = 0;
  const fetch_fn: typeof fetch = () => {
    calls += 1;
    return Promise.resolve(new Response(JSON.stringify(script(calls)), { status: 200 }));
  };
  return { fetch_fn, count: () => calls };
}

async function run_tool_turn(work_dir: string, args: Record<string, unknown>) {
  const fetch_script = scripted_fetch((call_count) => {
    if (call_count === 1) {
      return completion_body(tool_call_body("enemy_actions", args), "tool_calls");
    }
    return completion_body({ role: "assistant", content: "replanned" }, "stop");
  });
  const agent = await create_agent_with_plugins({
    providers: [{ kind: "openai_compat", name: "mock", model: "mock-model", base_url: "http://mock.local/v1", fetch_fn: fetch_script.fetch_fn }],
    work_dir,
    session_dir: path.join(work_dir, "sessions"),
    max_turns: 4,
    log_level: "error",
    plugins: [PLUGIN_ABS],
  });
  const result = await agent.run({ input: "plan the round" });
  const tool_message = result.messages.find((message) => message.role === "tool");
  const content = tool_message?.role === "tool" ? tool_message.content : "";
  return { content, calls: fetch_script.count() };
}

async function orders_text(work_dir: string): Promise<string> {
  return readFile(path.join(work_dir, ".lich", "game", "orders.jsonl"), "utf8");
}

describe("load_plugins game_bridge", () => {
  it("loads the .mjs example from the documented relative path", async () => {
    const plugin = await load_game_bridge();
    const names = plugin.tools?.map((tool) => tool.name);
    expect(names).toEqual(["enemy_actions", "dungeon_memory_read", "dungeon_memory_write"]);
    expect(names).not.toContain("git_commit");
    expect(plugin.name).not.toBe("gatekeeper");
    expect(plugin.hooks?.before_tool_call).toBeTypeOf("function");
    const readme = await readFile(path.join(REPO, "examples/game_bridge/README.md"), "utf8");
    expect(readme).toContain('"plugins": ["./examples/game_bridge/game_bridge.plugin.mjs"]');
  });
});

describe("game_bridge file effects", () => {
  it("appends one orders.jsonl line and echoes the action count", async () => {
    const work_dir = await make_temp_dir();
    const plugin = await load_game_bridge();
    const result = await require_tool(plugin, "enemy_actions").execute(strike(1), tool_context(work_dir));
    expect(result).toEqual({ ok: true, output: "appended 1 orders for round 1" });
    const raw = await orders_text(work_dir);
    const line = JSON.parse(raw.trim()) as { round: number; actions: { action: string }[]; rationale: string };
    expect(line.round).toBe(1);
    expect(line.actions).toEqual([{ enemy_id: "goblin", action: "attack", target_ref: "hero:hero1" }]);
    expect(line.rationale).toBe("open with a strike");
  });

  it("appends a second order line instead of rewriting the first", async () => {
    const work_dir = await make_temp_dir();
    const tool = require_tool(await load_game_bridge(), "enemy_actions");
    await tool.execute(strike(1), tool_context(work_dir));
    await tool.execute(strike(2, "defend"), tool_context(work_dir));
    const lines = (await orders_text(work_dir)).trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("still appends when the snapshot round does not match", async () => {
    const work_dir = await make_temp_dir();
    const game_dir = path.join(work_dir, ".lich", "game");
    await mkdir(game_dir, { recursive: true });
    await writeFile(path.join(game_dir, "state.json"), JSON.stringify({ round: 5 }), "utf8");
    const result = await require_tool(await load_game_bridge(), "enemy_actions").execute(strike(1), tool_context(work_dir));
    expect(result.ok).toBe(true);
    expect(result.output).toContain("snapshot_round_mismatch: snapshot=5");
    expect(await orders_text(work_dir)).toContain('"round":1');
  });

  it("returns an error result for a malformed order and does not throw", async () => {
    const work_dir = await make_temp_dir();
    const result = await require_tool(await load_game_bridge(), "enemy_actions").execute(
      { round: 1, actions: [{ enemy_id: "goblin", action: "attack", target_ref: "party" }] },
      tool_context(work_dir),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("rationale_required");
    expect(existsSync(path.join(work_dir, ".lich", "game", "orders.jsonl"))).toBe(false);
  });

  it("writes a note, skips a corrupt line, and returns the recent notes joined", async () => {
    const work_dir = await make_temp_dir();
    const plugin = await load_game_bridge();
    const write_tool = require_tool(plugin, "dungeon_memory_write");
    const read_tool = require_tool(plugin, "dungeon_memory_read");
    expect(await read_tool.execute({}, tool_context(work_dir))).toEqual({ ok: true, output: "(none)" });
    const written = await write_tool.execute({ note: "heals below half" }, tool_context(work_dir));
    expect(written).toEqual({ ok: true, output: "appended 1 note" });
    const memory_path = path.join(work_dir, ".lich", "game", "memory.jsonl");
    await writeFile(memory_path, `${await readFile(memory_path, "utf8")}not-json\n`, "utf8");
    await write_tool.execute({ note: "opens with fire" }, tool_context(work_dir));
    const read = await read_tool.execute({}, tool_context(work_dir));
    expect(read).toEqual({ ok: true, output: "heals below half\nopens with fire" });
    const raw = await readFile(memory_path, "utf8");
    expect(raw).toContain("not-json");
  });

  it("caps dungeon_memory_read at the most recent 20 notes", async () => {
    const work_dir = await make_temp_dir();
    const write_tool = require_tool(await load_game_bridge(), "dungeon_memory_write");
    for (let index = 1; index <= 22; index += 1) {
      await write_tool.execute({ note: `note-${index}` }, tool_context(work_dir));
    }
    const read = await require_tool(await load_game_bridge(), "dungeon_memory_read").execute({}, tool_context(work_dir));
    expect(read.ok).toBe(true);
    expect(read.output.split("\n")).toEqual(Array.from({ length: 20 }, (_unused, index) => `note-${index + 3}`));
  });

  it("returns an error result when a memory write has no note", async () => {
    const work_dir = await make_temp_dir();
    const result = await require_tool(await load_game_bridge(), "dungeon_memory_write").execute({}, tool_context(work_dir));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("note_required");
  });
});

describe("meteor veto", () => {
  it("blocks meteor before round 3, writes nothing, and re-plans", async () => {
    const work_dir = await make_temp_dir();
    const turn = await run_tool_turn(work_dir, strike(2, "meteor"));
    expect(turn.content).toContain("blocked_by_plugin: meteor_gates_closed_until_round_3");
    expect(turn.calls).toBe(2);
    expect(existsSync(path.join(work_dir, ".lich", "game", "orders.jsonl"))).toBe(false);
  });

  it("lets meteor through on round 3 and appends the order", async () => {
    const work_dir = await make_temp_dir();
    const turn = await run_tool_turn(work_dir, strike(3, "meteor"));
    expect(turn.content).toBe("appended 1 orders for round 3");
    expect(turn.calls).toBe(2);
    expect(await orders_text(work_dir)).toContain('"action":"meteor"');
  });
});

function scrub_env(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["OPENAI_API_KEY"];
  delete env["ANTHROPIC_API_KEY"];
  return env;
}

function attack_turn() {
  return completion_body(tool_call_body("enemy_actions", strike(1)), "tool_calls");
}

function stop_turn() {
  return completion_body({ role: "assistant", content: "queued" }, "stop");
}

function start_mock_chat(): Promise<{ url: string; bodies: string[]; close: () => Promise<void> }> {
  const bodies: string[] = [];
  let count = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      count += 1;
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      const body = count === 1 ? attack_turn() : stop_turn();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        bodies,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function run_node(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: scrub_env() });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("cli timed out"));
    }, 15000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

describe("dist cli loads the .mjs plugin", () => {
  it("runs enemy_actions from config.plugins through node dist/cli.js", async () => {
    expect(existsSync(CLI), "build dist first (package.json build script) so node dist/cli.js exists").toBe(true);
    const work_dir = await make_temp_dir();
    const config_path = path.join(work_dir, "config.json");
    const mock = await start_mock_chat();
    // Absolute plugin path + TMP_BASE work_dir: never touch <repo>/.lich/game.
    await writeFile(
      config_path,
      JSON.stringify({
        providers: [{ kind: "openai_compat", name: "mock", model: "mock-model", base_url: mock.url }],
        plugins: [PLUGIN_ABS],
        max_turns: 4,
        log_level: "error",
      }),
      "utf8",
    );
    try {
      const result = await run_node(
        [
          CLI,
          "--config",
          config_path,
          "--work-dir",
          work_dir,
          "--session-dir",
          path.join(work_dir, "sessions"),
          "plan the round",
        ],
        work_dir,
      );
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("enemy_actions: ok");
      expect(result.stderr).not.toContain("plugin load errors");
      expect(result.stdout).toContain("queued");
      expect(mock.bodies[0]).toContain("enemy_actions");
      expect(await orders_text(work_dir)).toContain('"action":"attack"');
      expect(existsSync(path.join(REPO, ".lich", "game"))).toBe(false);
    } finally {
      await mock.close();
    }
  });
});
