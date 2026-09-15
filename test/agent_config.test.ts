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
    const config = parse_agent_config({ providers: minimal_providers });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.providers)).toBe(true);
    expect(Object.isFrozen(config.providers[0])).toBe(true);
  });
});