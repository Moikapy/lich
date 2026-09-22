/**
 * General MCP client. A mock stdio server and a mock fetch only — these tests
 * never spawn Godot or Redot and never touch the network.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { parse_agent_config } from "../src/agent/config.js";
import { catalog_client_entry } from "../src/mcp/mcp_catalog_entry.js";
import { plan_stdio } from "../src/mcp/mcp_plan.js";
import { create_line_queue } from "../src/mcp/mcp_lines.js";
import { attach_enabled_mcp_tools } from "../src/mcp/mcp_tools.js";
import type { LineSpawner } from "../src/mcp/mcp_stdio.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { persona_by_id, persona_config, PERSONA_TABLE } from "../examples/persona_orchestrator/personas.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const created: string[] = [];
const providers = [{ kind: "openai_compat" as const, name: "main", model: "mock-model" }];
const REDOT_ARGS = ["--headless", "--mcp-server", "--path"] as const;
const REDOT_TOOLS = ["scene_action", "resource_action", "code_intel", "project_config", "game_control"];

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function temp_dir(prefix: string): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(path.join(TMP_BASE, `${prefix}-`));
  created.push(dir);
  return dir;
}

interface SpawnRecord {
  calls: number;
  command?: string;
  args?: readonly string[];
  env?: Record<string, string>;
  methods: string[];
  tool_names: string[];
  stopped: number;
}

function redot_args(project: string): string[] {
  return [...REDOT_ARGS, project];
}

function mock_spawner(record: SpawnRecord, tools = REDOT_TOOLS, handshake = true): LineSpawner {
  return (command, args, env) => {
    record.calls += 1;
    record.command = command;
    record.args = args;
    record.env = env;
    const queue = create_line_queue();
    return {
      write_line(line: string): void {
        const msg = JSON.parse(line) as {
          id?: number;
          method?: string;
          params?: { name?: string };
        };
        if (typeof msg.method === "string") {
          record.methods.push(msg.method);
        }
        if (msg.method === "notifications/initialized") {
          return;
        }
        if (msg.method === "tools/call" && typeof msg.params?.name === "string") {
          record.tool_names.push(msg.params.name);
        }
        const result = msg.method === "initialize"
          ? handshake
            ? { protocolVersion: "2024-11-05", serverInfo: { name: "mock-mcp" } }
            : { protocolVersion: "2024-11-05" }
          : msg.method === "tools/list"
            ? { tools: tools.map((name) => ({ name, description: name, inputSchema: { type: "object" } })) }
            : { content: [{ type: "text", text: "scene ok" }] };
        queue.push(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      },
      read_line: () => queue.read(),
      stop(): void {
        record.stopped += 1;
        queue.close();
      },
      failed: () => undefined,
    };
  };
}

function empty_record(): SpawnRecord {
  return { calls: 0, methods: [], tool_names: [], stopped: 0 };
}

function boom_spawn(): LineSpawner {
  return () => {
    throw new Error("spawned");
  };
}

function chat_ok(): { choices: unknown[]; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } } {
  return {
    choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

async function visible_tools(raw: Record<string, unknown>, spawn?: LineSpawner): Promise<string[]> {
  const seen: string[] = [];
  const fetch_fn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { tools?: Array<{ function: { name: string } }> };
    for (const tool of body.tools ?? []) {
      seen.push(tool.function.name);
    }
    return new Response(JSON.stringify(chat_ok()), { status: 200 });
  };
  const agent = new Agent(parse_agent_config({
    ...raw,
    providers: [{ ...providers[0], base_url: "http://127.0.0.1:9", fetch_fn }],
    log_level: "error",
  }), [], spawn === undefined ? undefined : { mcp: { spawn } });
  try {
    await agent.run({ input: "ping" });
  } finally {
    agent.close();
  }
  return seen;
}

describe("mcp refusal", () => {
  it("refuses downloaders, urls, shells, remote hosts, and a non-redot basename on the redot entry", async () => {
    const work_dir = await temp_dir("mcp-refuse");
    const project = path.join(work_dir, "game");
    const binary = path.join(work_dir, "redot");
    await writeFile(binary, "");
    expect(plan_stdio("lab", "npx", ["-y", "addon"], undefined)).toMatch(/download command 'npx'/);
    expect(plan_stdio("lab", "uvx", ["addon"], undefined)).toMatch(/uvx/);
    expect(plan_stdio("lab", "curl", ["https://example.invalid/addon"], undefined)).toMatch(/curl/);
    expect(plan_stdio("lab", "https://redotengine.org/redot", [], undefined)).toMatch(/refused url/);
    expect(plan_stdio("lab", "redot; rm", [], undefined)).toMatch(/shell/);
    expect(plan_stdio("lab", "bash", ["-c", "npx -y x"], undefined)).toMatch(/shell 'bash'/);
    expect(plan_stdio("lab", "sh", ["-c", "curl x"], undefined)).toMatch(/shell 'sh'/);
    expect(plan_stdio("lab", "env", ["npx", "-y", "x"], undefined)).toMatch(/env → 'npx'|download/);
    expect(plan_stdio("lab", "env", ["-i", "bash", "-c", "x"], undefined)).toMatch(/env → 'bash'|shell/);
    expect(plan_stdio("lab", "env", ["-S", "bash -c x"], undefined)).toMatch(/env -S|split-string/);
    expect(plan_stdio("lab", "node", ["--eval=1"], undefined)).toMatch(/eval flag/);
    expect(plan_stdio("lab", "bun", ["x", "pkg"], undefined)).toMatch(/bun x/);
    expect(plan_stdio("lab", "node", ["-e", "1"], undefined)).toMatch(/eval flag/);
    expect(plan_stdio("redot", path.join(work_dir, "godot"), redot_args(project), undefined)).toMatch(/basename 'godot'/);
    expect(plan_stdio("redot", binary, ["--headless", "--mcp-server", "--path", "https://evil.example/game"], undefined)).toMatch(/refused project path/);
    expect(plan_stdio("lab", path.join(work_dir, "lab"), ["https://evil.example/addon"], undefined)).toMatch(/refused url in mcp args/);
    expect(() => parse_agent_config({
      providers,
      mcp_servers: { remote: { url: "http://0.0.0.0:9/mcp" } },
    })).toThrow(/loopback/);
    expect(() => parse_agent_config({
      providers,
      mcp_servers: { remote: { url: "https://example.invalid/mcp" } },
    })).toThrow(/loopback/);
  });

  it("names the official install when redot is missing and never spawns", async () => {
    const work_dir = await temp_dir("mcp-missing");
    const missing = path.join(work_dir, "missing", "redot");
    const planned = plan_stdio("redot", missing, redot_args(path.join(work_dir, "game")), undefined);
    expect(planned).toMatch(/Redot 26\.1\+/);
    expect(planned).toMatch(/redotengine\.org/);
    const spawn = boom_spawn();
    const registry = new ToolRegistry();
    const config = parse_agent_config({
      providers,
      work_dir,
      log_level: "error",
      mcp_servers: {
        redot: { enabled: true, command: missing, args: redot_args(path.join(work_dir, "game")) },
      },
    });
    await attach_enabled_mcp_tools(registry, config, { spawn });
    expect(registry.list()).toEqual([]);
  });

  it("plans only the official argv for a redot basename", async () => {
    const work_dir = await temp_dir("mcp-plan");
    const binary = path.join(work_dir, "redot");
    await writeFile(binary, "");
    const project = path.join(work_dir, "game");
    expect(plan_stdio("redot", binary, redot_args(project), undefined)).toEqual({
      command: binary,
      args: redot_args(project),
    });
    expect(plan_stdio("redot", "redot", ["--script", "evil.gd"], work_dir)).toMatch(/refused redot args/);
  });
});

describe("mcp catalog", () => {
  it("writes a disabled redot entry and no godot spawn plan", () => {
    const redot = catalog_client_entry("redot", { project_path: "/home/me/game" });
    expect(redot).toEqual({
      enabled: false,
      command: "redot",
      args: redot_args("/home/me/game"),
    });
    expect(catalog_client_entry("godot")).toMatch(/no official MCP server/);
    expect(catalog_client_entry("missing")).toMatch(/unknown/);
  });
});

describe("mcp handshake", () => {
  it("lists tools, prefixes names, and calls the unprefixed wire name", async () => {
    const work_dir = await temp_dir("mcp-shake");
    const binary = path.join(work_dir, "redot");
    await writeFile(binary, "");
    const project = path.join(work_dir, "game");
    const record = empty_record();
    const config = parse_agent_config({
      providers,
      work_dir,
      log_level: "error",
      tools_enabled: "all",
      mcp_servers: { redot: { enabled: true, command: binary, args: redot_args(project) } },
    });
    const registry = new ToolRegistry();
    await attach_enabled_mcp_tools(registry, config, { spawn: mock_spawner(record) });
    const names = registry.list().map((tool) => tool.name);
    expect(names).toEqual(REDOT_TOOLS.map((tool) => `mcp_redot_${tool}`));
    expect(names.some((name) => name.includes("execute"))).toBe(false);
    const scene = registry.get("mcp_redot_scene_action");
    const result = await scene?.execute({ action: "get_node" }, { work_dir, env: {} });
    expect(result).toEqual({ ok: true, output: "scene ok" });
    expect(record.calls).toBe(1);
    expect(record.args).toEqual(redot_args(project));
    expect(record.methods).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    expect(record.tool_names).toEqual(["scene_action"]);
  });

  it("drops a catalog execute tool and keeps a custom server's execute tool", async () => {
    const work_dir = await temp_dir("mcp-execute");
    const redot = path.join(work_dir, "redot");
    const lab = path.join(work_dir, "lab");
    await writeFile(redot, "");
    await writeFile(lab, "");
    const config = parse_agent_config({
      providers,
      work_dir,
      log_level: "error",
      mcp_servers: {
        redot: { enabled: true, command: redot, args: redot_args(work_dir) },
        lab: { enabled: true, command: lab, args: ["--stdio"] },
      },
    });
    const registry = new ToolRegistry();
    await attach_enabled_mcp_tools(registry, config, {
      spawn: mock_spawner(empty_record(), ["execute", "ping"]),
    });
    const names = registry.list().map((tool) => tool.name).sort();
    expect(names).toEqual(["mcp_lab_execute", "mcp_lab_ping", "mcp_redot_ping"]);
  });

  it("excludes execute when a custom name runs the redot binary (M-5)", async () => {
    const work_dir = await temp_dir("mcp-redot-alias");
    const redot = path.join(work_dir, "redot");
    await writeFile(redot, "");
    const config = parse_agent_config({
      providers,
      work_dir,
      log_level: "error",
      mcp_servers: {
        my_redot: { enabled: true, command: redot, args: redot_args(work_dir) },
      },
    });
    const registry = new ToolRegistry();
    await attach_enabled_mcp_tools(registry, config, {
      spawn: mock_spawner(empty_record(), ["execute", "scene_action", "ping"]),
    });
    const names = registry.list().map((tool) => tool.name).sort();
    expect(names).toEqual(["mcp_my_redot_ping", "mcp_my_redot_scene_action"]);
    expect(plan_stdio("my_redot", redot, ["--script", "evil.gd"], work_dir)).toMatch(/refused redot args/);
  });

  it("rejects a bad handshake and does not register tools", async () => {
    const work_dir = await temp_dir("mcp-bad-handshake");
    const binary = path.join(work_dir, "redot");
    await writeFile(binary, "");
    const record = empty_record();
    const config = parse_agent_config({
      providers,
      work_dir,
      log_level: "error",
      mcp_servers: { redot: { enabled: true, command: binary, args: redot_args(work_dir) } },
    });
    const registry = new ToolRegistry();
    await attach_enabled_mcp_tools(registry, config, { spawn: mock_spawner(record, REDOT_TOOLS, false) });
    expect(registry.list()).toEqual([]);
    expect(record.tool_names).toEqual([]);
    expect(record.stopped).toBe(1);
  });

  it("posts JSON-RPC to loopback and does not log env secrets", async () => {
    const work_dir = await temp_dir("mcp-http");
    const secret = "super-secret-token";
    const posts: string[] = [];
    const fetch_fn: typeof fetch = async (url, init) => {
      posts.push(`${String(url)} ${String(init?.body)}`);
      const body = JSON.parse(String(init?.body)) as { method?: string };
      const result = body.method === "initialize"
        ? { protocolVersion: "2024-11-05", serverInfo: { name: "loop" } }
        : { tools: [{ name: "ping", description: "ping" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", result }), { status: 200 });
    };
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map((part) => String(part)).join(" "));
    };
    try {
      const binary = path.join(work_dir, "redot");
      await writeFile(binary, "");
      const config = parse_agent_config({
        providers,
        work_dir,
        log_level: "warn",
        mcp_servers: {
          loop: { enabled: true, url: "http://127.0.0.1:9/mcp" },
          redot: {
            enabled: true,
            command: binary,
            args: redot_args(work_dir),
            env: { LICH_SECRET: secret },
          },
        },
      });
      const record = empty_record();
      const registry = new ToolRegistry();
      await attach_enabled_mcp_tools(registry, config, {
        fetch_fn,
        spawn: mock_spawner(record, REDOT_TOOLS, false),
      });
      expect(posts.some((line) => line.startsWith("http://127.0.0.1:9/mcp"))).toBe(true);
      expect(posts.join("\n")).not.toContain(secret);
      expect(logged.join("\n")).not.toContain(secret);
      expect(record.env?.LICH_SECRET).toBe(secret);
    } finally {
      console.error = original;
    }
  });
});

describe("mcp tool disablement", () => {
  it("closes stdio sessions on agent.close so the child stops", async () => {
    const work_dir = await temp_dir("mcp-close");
    const binary = path.join(work_dir, "redot");
    await writeFile(binary, "");
    const record = empty_record();
    const fetch_fn: typeof fetch = async () => new Response(JSON.stringify(chat_ok()), { status: 200 });
    const agent = new Agent(parse_agent_config({
      providers: [{ ...providers[0], base_url: "http://127.0.0.1:9", fetch_fn }],
      work_dir,
      log_level: "error",
      tools_enabled: "all",
      mcp_servers: { redot: { enabled: true, command: binary, args: redot_args(path.join(work_dir, "game")) } },
    }), [], { mcp: { spawn: mock_spawner(record) } });
    await agent.run({ input: "ping" });
    expect(record.calls).toBe(1);
    expect(record.stopped).toBe(0);
    agent.close();
    expect(record.stopped).toBe(1);
    agent.close();
    expect(record.stopped).toBe(1);
  });

  it("stays off unless enabled and tools_enabled allows the names", async () => {
    const work_dir = await temp_dir("mcp-off");
    const binary = path.join(work_dir, "redot");
    await writeFile(binary, "");
    const redot = { enabled: true, command: binary, args: redot_args(path.join(work_dir, "game")) };
    const spawn = boom_spawn();
    const off = await visible_tools({ work_dir }, spawn);
    expect(off.filter((name) => name.startsWith("mcp_"))).toEqual([]);
    const disabled = await visible_tools({ work_dir, mcp_servers: { redot: { ...redot, enabled: false } } }, spawn);
    expect(disabled.filter((name) => name.startsWith("mcp_"))).toEqual([]);
    const empty_allow = await visible_tools({ work_dir, tools_enabled: [], mcp_servers: { redot } }, spawn);
    expect(empty_allow.filter((name) => name.startsWith("mcp_"))).toEqual([]);
    const files_only = await visible_tools({ work_dir, tools_enabled: ["read_file"], mcp_servers: { redot } }, spawn);
    expect(files_only.filter((name) => name.startsWith("mcp_"))).toEqual([]);

    const record = empty_record();
    const named = await visible_tools({
      work_dir,
      tools_enabled: ["mcp_redot_scene_action"],
      mcp_servers: { redot },
    }, mock_spawner(record));
    expect(named.filter((name) => name.startsWith("mcp_"))).toEqual(["mcp_redot_scene_action"]);
    expect(record.calls).toBe(1);
  });

  it("keeps editor tools off the commander persona", async () => {
    const work_dir = await temp_dir("mcp-commander");
    const commander = persona_by_id(PERSONA_TABLE, "commander");
    if (commander === undefined) {
      throw new Error("missing commander");
    }
    const raw = persona_config({ providers, work_dir }, commander);
    expect(raw.tools_enabled).toEqual([]);
    expect(raw).not.toHaveProperty("mcp_servers");
    expect(raw.plugins).toEqual(["./examples/game_bridge/game_bridge.plugin.mjs"]);
    const seen = await visible_tools({ ...raw, work_dir }, boom_spawn());
    expect(seen.filter((name) => name.startsWith("mcp_"))).toEqual([]);
  });

  it("rejects unknown keys, remote urls, and non-snake names; defaults enabled to false", () => {
    expect(() => parse_agent_config({
      providers,
      mcp_servers: { redot: { enabled: true, command: "redot", args: redot_args("/game"), url: "http://127.0.0.1" } },
    })).toThrow();
    expect(() => parse_agent_config({
      providers,
      mcp_servers: { notes: { enabled: true, extra: true } },
    })).toThrow();
    expect(() => parse_agent_config({
      providers,
      mcp_servers: { "redot-mcp": { command: "redot", args: redot_args("/game") } },
    })).toThrow(/snake_case/);
    const config = parse_agent_config({
      providers,
      mcp_servers: { loop: { url: "http://localhost:9/mcp" } },
    });
    expect(config.mcp_servers?.loop).toEqual({ enabled: false, url: "http://localhost:9/mcp" });
    expect(Object.isFrozen(config.mcp_servers?.loop)).toBe(true);
  });
});
