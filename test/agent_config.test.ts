import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { parse_agent_config } from "../src/agent/config.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const minimal_providers = [{ kind: "openai_compat", name: "main", model: "mock-model" }];

describe("parse_agent_config", () => {
  it("applies defaults for a minimal valid config", () => {
    const config = parse_agent_config({ providers: minimal_providers });
    expect(config.max_turns).toBe(25);
    expect(config.context_budget_tokens).toBe(100000);
    expect(config.compress_threshold).toBe(0.8);
    expect(config.tools_enabled).toBe("all");
    expect(config.terminal_timeout_ms).toBe(60000);
    expect(config.log_level).toBe("info");
    expect(config.theme).toBe("lich");
    expect(config.work_dir).toBe(process.cwd());
    expect(config.session_dir).toBe(`${process.cwd()}/.lich/sessions`);
  });

  it("throws when providers are missing", () => {
    expect(() => parse_agent_config({})).toThrow();
  });

  it("throws when providers array is empty", () => {
    expect(() => parse_agent_config({ providers: [] })).toThrow();
  });

  it("throws on an unknown provider kind", () => {
    expect(() => parse_agent_config({ providers: [{ kind: "wat", name: "x", model: "y" }] })).toThrow();
  });

  it("throws on invalid numeric fields", () => {
    expect(() => parse_agent_config({ providers: minimal_providers, max_turns: 0 })).toThrow();
    expect(() => parse_agent_config({ providers: minimal_providers, compress_threshold: 0.05 })).toThrow();
    expect(() => parse_agent_config({ providers: minimal_providers, temperature: 2.5 })).toThrow();
    expect(() => parse_agent_config({ providers: minimal_providers, max_tokens: 1.5 })).toThrow();
  });

  it("accepts the array form of tools_enabled", () => {
    const config = parse_agent_config({
      providers: minimal_providers,
      tools_enabled: ["read_file", "shell"],
    });
    expect(config.tools_enabled).toEqual(["read_file", "shell"]);
  });

  it("defaults gateway allowlists empty and tools to the safe subset", () => {
    const config = parse_agent_config({
      providers: minimal_providers,
      gateway: {},
    });
    expect(config.gateway?.allowed_users).toEqual({});
    expect(config.gateway?.allowed_chats).toEqual({});
    expect(config.gateway?.tools_enabled).toEqual([
      "read_file",
      "list_dir",
      "grep_files",
      "fetch_url",
      "web_search",
      "docs_read",
      "docs_search",
    ]);
  });

  it("applies log_level debug without throwing", () => {
    const config = parse_agent_config({ providers: minimal_providers, log_level: "debug" });
    expect(config.log_level).toBe("debug");
  });

  it("computes session_dir from work_dir at parse time", async () => {
    await mkdir(TMP_BASE, { recursive: true });
    const work_dir = await mkdtemp(path.join(TMP_BASE, "config-work-"));
    try {
      const config = parse_agent_config({ providers: minimal_providers, work_dir });
      expect(config.work_dir).toBe(work_dir);
      expect(config.session_dir).toBe(`${work_dir}/.lich/sessions`);
    } finally {
      await rm(work_dir, { recursive: true, force: true });
    }
  });

  it("returns a deep-frozen config object", () => {
    const config = parse_agent_config({
      providers: minimal_providers,
      tools_enabled: ["read_file"],
      plugins: ["./plugin.js"],
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.providers)).toBe(true);
    expect(Object.isFrozen(config.providers[0])).toBe(true);
    expect(Object.isFrozen(config.plugins)).toBe(true);
    expect(Object.isFrozen(config.tools_enabled)).toBe(true);
  });

  it("rejects duplicate provider names", () => {
    expect(() =>
      parse_agent_config({
        providers: [
          { kind: "openai_compat", name: "main", model: "a" },
          { kind: "anthropic", name: "main", model: "b" },
        ],
      }),
    ).toThrow(/duplicate provider name/);
  });

  it("rejects toolset, platform, allowlist, and plugin-role typos", () => {
    const open = parse_agent_config({
      providers: minimal_providers,
      tools_enabled: "all",
      gateway: { tools_enabled: "all", platforms: ["webhook", "discord"] },
    });
    expect(open.tools_enabled).toBe("all");
    expect(open.gateway?.tools_enabled).toBe("all");
    expect(open.gateway?.platforms).toEqual(["webhook", "discord"]);

    const rejected = [
      { providers: minimal_providers, tools_enabled: "ALL" },
      { providers: minimal_providers, tools_enabled: "all " },
      { providers: minimal_providers, tools_enabled: "none" },
      { providers: minimal_providers, gateway: { tools_enabled: "ALL" } },
      { providers: minimal_providers, gateway: { platforms: ["Discord"] } },
      { providers: minimal_providers, gateway: { allowed_users: { discord: [1] } } },
      { providers: minimal_providers, gateway: { allowed_chats: { twitch: ["ok", false] } } },
      { providers: minimal_providers, gateway: { token_envs: { discord: "1TOKEN" } } },
      { providers: minimal_providers, gateway: { token_envs: { discord: "" } } },
      { providers: minimal_providers, gateway: { token_envs: { discord: "HAS-DASH" } } },
      { providers: minimal_providers, plugins: [{ path: "p.js", model: ["chat"] }] },
      { providers: minimal_providers, plugins: [{ path: "p.js", models: ["Chat"] }] },
      { providers: minimal_providers, log_level: "INFO" },
    ];
    for (const raw of rejected) {
      expect(() => parse_agent_config(raw)).toThrow();
    }
    let token_error = "";
    try {
      parse_agent_config({
        providers: minimal_providers,
        gateway: { token_envs: { discord: "1TOKEN" } },
      });
    } catch (error) {
      token_error = error instanceof Error ? error.message : String(error);
    }
    expect(token_error).toMatch(/invalid env var name/);
    expect(token_error).not.toContain("1TOKEN");
  });

  it("keeps inclusive numeric bounds and an explicit session_dir", () => {
    const config = parse_agent_config({
      providers: [{ ...minimal_providers[0], timeout_ms: 1 }],
      temperature: 0,
      compress_threshold: 0.1,
      context_budget_tokens: 1,
      max_tokens: 1,
      max_turns: 1,
      terminal_timeout_ms: 1,
      work_dir: "/tmp/project",
      session_dir: "/var/lich/sessions",
    });
    expect(config.temperature).toBe(0);
    expect(config.compress_threshold).toBe(0.1);
    expect(config.context_budget_tokens).toBe(1);
    expect(config.max_tokens).toBe(1);
    expect(config.max_turns).toBe(1);
    expect(config.terminal_timeout_ms).toBe(1);
    expect(config.providers[0]?.timeout_ms).toBe(1);
    expect(config.work_dir).toBe("/tmp/project");
    expect(config.session_dir).toBe("/var/lich/sessions");

    const upper = parse_agent_config({
      providers: minimal_providers,
      temperature: 2,
      compress_threshold: 0.95,
    });
    expect(upper.temperature).toBe(2);
    expect(upper.compress_threshold).toBe(0.95);

    const rejected = [
      { temperature: -0.1 },
      { temperature: 2.0001 },
      { compress_threshold: 0.96 },
      { compress_threshold: 0 },
      { context_budget_tokens: 0 },
      { context_budget_tokens: 1.2 },
      { max_tokens: 0 },
      { max_turns: 1.5 },
      { terminal_timeout_ms: 0 },
      { providers: [{ ...minimal_providers[0], timeout_ms: 0 }] },
      { providers: [{ ...minimal_providers[0], timeout_ms: 1.5 }] },
    ];
    for (const extra of rejected) {
      expect(() => parse_agent_config({ providers: minimal_providers, ...extra })).toThrow();
    }
  });

  it("freezes gateway tool lists and plugin role grants", () => {
    const config = parse_agent_config({
      providers: minimal_providers,
      gateway: {
        platforms: ["webhook"],
        tools_enabled: ["read_file"],
        token_envs: { webhook: "LICH_GATEWAY_TOKEN" },
      },
      plugins: [{ path: "p.js", settings: { mode: "safe" }, models: ["chat"] }],
    });
    expect(Object.isFrozen(config.gateway?.platforms)).toBe(true);
    expect(Object.isFrozen(config.gateway?.tools_enabled)).toBe(true);
    expect(Object.isFrozen(config.gateway?.token_envs)).toBe(true);
    const plugin = config.plugins[0];
    expect(typeof plugin).toBe("object");
    if (typeof plugin === "string" || plugin === undefined) {
      return;
    }
    const models = plugin.models;
    const settings = plugin.settings;
    expect(models).toEqual(["chat"]);
    expect(settings).toEqual({ mode: "safe" });
    expect(Object.isFrozen(models)).toBe(true);
    expect(Object.isFrozen(settings)).toBe(true);
    if (models === undefined || settings === undefined) {
      return;
    }
    expect(() => {
      (models as string[]).push("compress");
    }).toThrow(TypeError);
    expect(() => {
      settings.mode = "open";
    }).toThrow(TypeError);
    expect(() => {
      (config.gateway?.tools_enabled as string[]).push("terminal");
    }).toThrow(TypeError);
    expect(() => {
      (config.gateway?.token_envs as Record<string, string>).discord = "DISCORD_BOT_TOKEN";
    }).toThrow(TypeError);
    expect(models).toEqual(["chat"]);
    expect(config.gateway?.tools_enabled).toEqual(["read_file"]);
  });
});