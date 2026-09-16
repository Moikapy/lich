/**
 * First-run setup: one writer for `lich init` and the bare-`lich` wizard.
 * No network. Config discovery ignores the real user-home file.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TMP_BASE } from "./helpers/tmp_base.js";

const writes = vi.hoisted(() => ({ calls: [] as Array<{ work_dir: string; config: Record<string, unknown> }> }));
const wizard = vi.hoisted(() => ({ cancel: false, lines: [] as string[] }));
const tui_run = vi.hoisted(() => ({ configs: [] as Array<{ providers?: Array<{ model?: string }> }> }));
const gateway_run = vi.hoisted(() => ({
  fn: vi.fn(async (_config: unknown, _platforms: readonly string[]) => 0),
}));
vi.mock("../src/cli_config.js", async (import_original) => {
  const path_mod = await import("node:path");
  const fs_mod = await import("node:fs");
  const actual = await import_original<typeof import("../src/cli_config.js")>();
  return {
    ...actual,
    write_lich_config: (work_dir: string, config: Record<string, unknown>) => {
      writes.calls.push({ work_dir, config });
      return actual.write_lich_config(work_dir, config);
    },
    existing_config_path: (work_dir: string) => {
      const [project] = actual.config_search_paths(work_dir);
      const found = actual.existing_config_path(work_dir);
      if (found !== undefined && found === project) {
        return found;
      }
      const absent_home = path_mod.resolve(work_dir, "missing-home-config.json");
      return fs_mod.existsSync(absent_home) === true ? absent_home : undefined;
    },
  };
});

vi.mock("node:readline", () => ({
  createInterface: () => ({
    question: (_prompt: string, callback: (line: string) => void) => {
      if (wizard.cancel === true) {
        return;
      }
      callback(wizard.lines.shift() ?? "");
    },
    once: (event: string, callback: () => void) => {
      if (wizard.cancel === true && (event === "SIGINT" || event === "close")) {
        callback();
      }
    },
    removeListener: () => undefined,
    close: () => undefined,
  }),
}));

vi.mock("ink", () => ({
  render: () => ({ waitUntilExit: () => Promise.resolve() }),
}));

vi.mock("../src/tui.js", () => ({
  run_tui: async (config: { providers?: Array<{ model?: string }> }) => {
    tui_run.configs.push(config);
    return 0;
  },
}));

vi.mock("../src/gateway.js", () => ({
  run_gateway: gateway_run.fn,
}));

import { parse_agent_config } from "../src/agent/config.js";
import { config_search_paths, existing_config_path, project_config_path, write_lich_config } from "../src/cli_config.js";
import { read_platform_token } from "../src/gateway/token_env.js";
import { build_setup_config, collect_setup_answers } from "../src/setup_wizard.js";
import { run_cli } from "../src/cli.js";
import { tui_banner_text } from "../src/tui/state.js";

const created: string[] = [];
const saved_env: Record<string, string | undefined> = {};

function make_temp_dir(prefix: string): string {
  mkdirSync(TMP_BASE, { recursive: true });
  const dir = mkdtempSync(path.join(TMP_BASE, `${prefix}-`));
  created.push(dir);
  return dir;
}

function set_tty(value: boolean): () => void {
  const previous = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
  return () => {
    if (previous === undefined) {
      Reflect.deleteProperty(process.stdin, "isTTY");
      return;
    }
    Object.defineProperty(process.stdin, "isTTY", previous);
  };
}

function without_model_env(body: () => Promise<void>): Promise<void> {
  const keys = ["LICH_MODEL", "LICH_PROVIDER_KIND", "LICH_BASE_URL", "LICH_API_KEY_ENV"] as const;
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return body().finally(() => {
    for (const key of keys) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });
}

beforeEach(() => {
  writes.calls = [];
  wizard.cancel = false;
  wizard.lines = [];
  tui_run.configs = [];
  gateway_run.fn.mockClear();
  for (const key of ["LICH_MODEL", "LICH_PROVIDER_KIND"] as const) {
    saved_env[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of Object.keys(saved_env)) {
    if (saved_env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved_env[key];
    }
  }
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("write_lich_config", () => {
  it("writes once and does not overwrite an existing config", () => {
    const dir = make_temp_dir("write");
    const first = write_lich_config(dir, { providers: [{ kind: "ollama", name: "main", model: "first" }] });
    const file = project_config_path(dir);
    expect(first.written).toBe(true);
    expect(existsSync(file)).toBe(true);
    const original = readFileSync(file, "utf8");
    const second = write_lich_config(dir, { providers: [{ kind: "ollama", name: "main", model: "second" }] });
    expect(second.written).toBe(false);
    expect(second.message).toContain("already exists");
    expect(second.message).toContain("not overwriting");
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("finds a user-home config without touching the project file", () => {
    const dir = make_temp_dir("home");
    const home = path.join(dir, "home-config.json");
    writeFileSync(home, "{}\n");
    const [project] = config_search_paths(dir);
    const spliced = [project, path.resolve(home)];
    expect(spliced).toEqual([project_config_path(dir), path.resolve(home)]);
    expect(spliced.find((candidate) => candidate !== undefined && existsSync(candidate))).toBe(path.resolve(home));
    expect(existsSync(project_config_path(dir))).toBe(false);
  });
});

describe("lich init and bare lich", () => {
  it("share write_lich_config, and init does not overwrite", async () => {
    await without_model_env(async () => {
      const init_dir = make_temp_dir("init");
      const wizard_dir = make_temp_dir("wizard");
      const restore_tty = set_tty(true);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        expect(await run_cli(["init", "--work-dir", init_dir])).toBe(0);
        expect(await run_cli(["--work-dir", wizard_dir])).toBe(0);
        expect(writes.calls.map((call) => call.work_dir)).toEqual([init_dir, wizard_dir]);
        const init_file = project_config_path(init_dir);
        const before = readFileSync(init_file, "utf8");
        expect(JSON.parse(before)).toMatchObject({ providers: [{ kind: "ollama" }] });
        expect(stdout.mock.calls.map((call) => String(call[0])).join("")).toContain("edit the model");
        stdout.mockClear();
        expect(await run_cli(["init", "--work-dir", init_dir])).toBe(0);
        expect(readFileSync(init_file, "utf8")).toBe(before);
        expect(stdout.mock.calls.map((call) => String(call[0])).join("")).toContain("not overwriting");
        expect(writes.calls).toHaveLength(3);
      } finally {
        stdout.mockRestore();
        restore_tty();
      }
    });
  });

  it("writes --model once, does not overwrite, and does not read a prompt", async () => {
    await without_model_env(async () => {
      const dir = make_temp_dir("init-model");
      wizard.lines = ["should-not-be-read"];
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        expect(await run_cli(["init", "--model", "script-model", "--work-dir", dir])).toBe(0);
        const file = project_config_path(dir);
        const body = readFileSync(file, "utf8");
        expect(JSON.parse(body)).toMatchObject({ providers: [{ model: "script-model" }] });
        expect(body).not.toContain("<model-name>");
        expect(stdout.mock.calls.map((call) => String(call[0])).join("")).not.toContain("edit the model");
        expect(wizard.lines).toEqual(["should-not-be-read"]);
        stdout.mockClear();
        expect(await run_cli(["init", "--model", "other-model", "--work-dir", dir])).toBe(0);
        expect(readFileSync(file, "utf8")).toBe(body);
        expect(stdout.mock.calls.map((call) => String(call[0])).join("")).toContain("not overwriting");
        expect(wizard.lines).toEqual(["should-not-be-read"]);
      } finally {
        stdout.mockRestore();
      }
    });
  });

  it("lets init flags win over LICH_MODEL", async () => {
    const dir = make_temp_dir("init-flag-wins");
    process.env.LICH_MODEL = "from-env";
    process.env.LICH_PROVIDER_KIND = "ollama";
    try {
      expect(await run_cli(["init", "--work-dir", dir, "--model", "from-flag", "--provider-kind", "anthropic"])).toBe(0);
      expect(JSON.parse(readFileSync(project_config_path(dir), "utf8"))).toMatchObject({
        providers: [{ kind: "anthropic", model: "from-flag" }],
      });
    } finally {
      delete process.env.LICH_MODEL;
      delete process.env.LICH_PROVIDER_KIND;
    }
  });

  it("skips the wizard when .lich/config.json already exists", async () => {
    const dir = make_temp_dir("skip");
    const file = project_config_path(dir);
    write_lich_config(dir, { providers: [{ kind: "ollama", name: "main", model: "kept" }], agent_name: "kept" });
    const original = readFileSync(file, "utf8");
    writes.calls = [];
    const restore_tty = set_tty(true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await run_cli(["--work-dir", dir])).toBe(0);
      expect(writes.calls).toHaveLength(0);
      expect(readFileSync(file, "utf8")).toBe(original);
      expect(stdout.mock.calls.map((call) => String(call[0])).join("")).toContain("skipping setup");
    } finally {
      stdout.mockRestore();
      restore_tty();
    }
  });

  it("does not write from non-TTY, cancelled setup, or scripted modes", async () => {
    const dir = make_temp_dir("no-write");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const restore_tty = set_tty(false);
    try {
      expect(await run_cli(["--work-dir", dir])).toBe(1);
      expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain("not a TTY");
      expect(writes.calls).toHaveLength(0);
      expect(existsSync(project_config_path(dir))).toBe(false);
    } finally {
      restore_tty();
      stderr.mockRestore();
    }

    const restore_on = set_tty(true);
    wizard.cancel = true;
    const stderr_cancel = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await run_cli(["--work-dir", dir])).toBe(1);
      expect(writes.calls).toHaveLength(0);
      expect(existsSync(project_config_path(dir))).toBe(false);
      expect(stderr_cancel.mock.calls.map((call) => String(call[0])).join("")).toContain("nothing written");
    } finally {
      stderr_cancel.mockRestore();
      restore_on();
      wizard.cancel = false;
    }

    await expect(run_cli(["tui", "--work-dir", dir])).rejects.toThrow(/no model configured/);
    await expect(run_cli(["chat", "--work-dir", dir])).rejects.toThrow(/no model configured/);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await run_cli(["config"])).toBe(0);
    } finally {
      stdout.mockRestore();
    }
    expect(writes.calls).toHaveLength(0);
  });

  it("prefills the provider step from LICH_MODEL and still writes a config", async () => {
    const dir = make_temp_dir("env-model");
    process.env.LICH_MODEL = "env-model";
    const restore_tty = set_tty(true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await run_cli(["--work-dir", dir])).toBe(0);
      expect(writes.calls).toHaveLength(1);
      expect(writes.calls[0]?.config).toMatchObject({ providers: [{ model: "env-model" }] });
      expect(existsSync(project_config_path(dir))).toBe(true);
      expect(tui_run.configs[0]?.providers?.[0]?.model).toBe("env-model");
    } finally {
      delete process.env.LICH_MODEL;
      stdout.mockRestore();
      restore_tty();
    }
  });

  it("prefills the provider step from --model and still writes a config", async () => {
    const dir = make_temp_dir("flag-model");
    const restore_tty = set_tty(true);
    try {
      expect(await run_cli(["--work-dir", dir, "--model", "flag-model"])).toBe(0);
      expect(writes.calls).toHaveLength(1);
      expect(writes.calls[0]?.config).toMatchObject({ providers: [{ model: "flag-model" }] });
      expect(existsSync(project_config_path(dir))).toBe(true);
      expect(tui_run.configs[0]?.providers?.[0]?.model).toBe("flag-model");
    } finally {
      restore_tty();
    }
  });

  it("pins a home-config skip into the load instead of a later discovery", async () => {
    const dir = make_temp_dir("pin-home");
    const home = path.join(dir, "missing-home-config.json");
    writeFileSync(home, JSON.stringify({ providers: [{ kind: "ollama", name: "main", model: "from-home" }] }));
    const cwd_dir = make_temp_dir("pin-cwd");
    mkdirSync(path.join(cwd_dir, ".lich"), { recursive: true });
    writeFileSync(path.join(cwd_dir, ".lich", "config.json"), JSON.stringify({
      providers: [{ kind: "ollama", name: "main", model: "from-cwd" }],
    }));
    const previous = process.cwd();
    process.chdir(cwd_dir);
    const restore_tty = set_tty(true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await run_cli(["--work-dir", dir])).toBe(0);
      expect(writes.calls).toHaveLength(0);
      expect(stdout.mock.calls.map((call) => String(call[0])).join("")).toContain("skipping setup");
      expect(tui_run.configs[0]?.providers?.[0]?.model).toBe("from-home");
      expect(existsSync(project_config_path(dir))).toBe(false);
    } finally {
      process.chdir(previous);
      stdout.mockRestore();
      restore_tty();
    }
  });

  it("lets lich tui pick up the file lich init wrote", async () => {
    await without_model_env(async () => {
      const dir = make_temp_dir("tui-pickup");
      const previous = process.cwd();
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      process.chdir(dir);
      try {
        expect(await run_cli(["init"])).toBe(0);
        expect(await run_cli(["tui"])).toBe(0);
        const parsed = parse_agent_config(JSON.parse(readFileSync(project_config_path(dir), "utf8")));
        expect(parsed.providers[0]?.model).toBe("<model-name>");
        expect(parsed.agent_name).toBe("lich");
      } finally {
        process.chdir(previous);
        stdout.mockRestore();
      }
    });
  });
});

describe("setup wizard fields", () => {
  it("lands name, provider, gateway env names, and plugins in the agent config", async () => {
    const dir = make_temp_dir("fields");
    mkdirSync(path.join(dir, ".lich", "plugins"), { recursive: true });
    writeFileSync(path.join(dir, ".lich", "plugins", "demo.ts"), "export const plugin = { name: 'demo', tools: [] };\n");
    const script = [
      "ada",
      "anthropic",
      "claude-test",
      "https://example.test/v1",
      "MY_ANTHROPIC_KEY",
      "telegram, webhook",
      "MY_TG_TOKEN",
      "LICH_GATEWAY_TOKEN",
      "y",
    ];
    let index = 0;
    const answers = await collect_setup_answers(dir, async () => script[index++]);
    expect(answers).toBeDefined();
    if (answers === undefined) {
      return;
    }
    const raw = build_setup_config(answers);
    const written = write_lich_config(dir, raw);
    expect(written.written).toBe(true);
    const body = readFileSync(written.path, "utf8");
    expect(body).not.toContain("super-secret");
    const config = parse_agent_config(JSON.parse(body));
    expect(config.agent_name).toBe("ada");
    expect(config.providers[0]).toMatchObject({
      kind: "anthropic",
      model: "claude-test",
      base_url: "https://example.test/v1",
      api_key_env: "MY_ANTHROPIC_KEY",
    });
    expect(config.gateway?.platforms).toEqual(["telegram", "webhook"]);
    expect(config.gateway?.token_envs).toEqual({ telegram: "MY_TG_TOKEN", webhook: "LICH_GATEWAY_TOKEN" });
    expect(config.plugins).toEqual([".lich/plugins/demo.ts"]);
    expect(tui_banner_text(config.agent_name, "0.3.0", config.providers[0]?.model ?? "", config.providers[0]?.kind ?? "")).toBe(
      "ada v0.3.0 — claude-test (anthropic)",
    );
    process.env.MY_TG_TOKEN = "super-secret";
    try {
      expect(read_platform_token(config, "telegram")).toBe("super-secret");
      expect(readFileSync(written.path, "utf8")).not.toContain("super-secret");
    } finally {
      delete process.env.MY_TG_TOKEN;
    }
    const again = write_lich_config(dir, { providers: [{ kind: "ollama", name: "main", model: "other" }] });
    expect(again.written).toBe(false);
    expect(readFileSync(written.path, "utf8")).toBe(body);
  });

  it("rejects an invalid token env name without writing or echoing it", async () => {
    const dir = make_temp_dir("bad-env");
    const pasted = "sk-live-secret";
    const prompts: string[] = [];
    const answers = await collect_setup_answers(dir, async (prompt) => {
      prompts.push(prompt);
      if (prompt.startsWith("Gateway platforms")) {
        return "telegram";
      }
      if (prompt.includes("token env") || prompt.includes("Env var name must match")) {
        return pasted;
      }
      return "";
    });
    expect(answers).toBeUndefined();
    expect(existsSync(project_config_path(dir))).toBe(false);
    expect(prompts.join("\n")).not.toContain(pasted);
    let thrown = "";
    try {
      parse_agent_config({
        providers: [{ kind: "ollama", name: "main", model: "m" }],
        gateway: { platforms: ["telegram"], token_envs: { telegram: pasted } },
      });
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    expect(thrown).toMatch(/invalid env var name/);
    expect(thrown).not.toContain(pasted);
  });

  it("refuses a bad name or a non-string env value already in a file", () => {
    process.env["sk-live"] = "should-not-read";
    try {
      const forged = {
        gateway: { token_envs: { telegram: "sk-live", twitch: "constructor" } },
      } as unknown as Parameters<typeof read_platform_token>[0];
      expect(read_platform_token(forged, "telegram")).toBeUndefined();
      expect(read_platform_token(forged, "twitch")).toBeUndefined();
    } finally {
      delete process.env["sk-live"];
    }
  });

  it("writes nothing when the first prompt is cancelled", async () => {
    const dir = make_temp_dir("cancel");
    const answers = await collect_setup_answers(dir, async () => undefined);
    expect(answers).toBeUndefined();
    expect(existsSync(project_config_path(dir))).toBe(false);
    expect(existing_config_path(dir)).toBeUndefined();
  });
});

describe("gateway platforms", () => {
  it("starts config.gateway.platforms when args are empty and lets a cli list win", async () => {
    const dir = make_temp_dir("gw");
    write_lich_config(dir, {
      providers: [{ kind: "ollama", name: "main", model: "kept" }],
      gateway: { platforms: ["telegram", "discord"], token_envs: { telegram: "MY_TG_TOKEN", discord: "MY_DC_TOKEN" } },
    });
    const previous = process.cwd();
    process.chdir(dir);
    try {
      expect(await run_cli(["gateway"])).toBe(0);
      expect(gateway_run.fn).toHaveBeenCalledWith(expect.anything(), ["telegram", "discord"]);
      gateway_run.fn.mockClear();
      expect(await run_cli(["gateway", "webhook"])).toBe(0);
      expect(gateway_run.fn).toHaveBeenCalledWith(expect.anything(), ["webhook"]);
    } finally {
      process.chdir(previous);
    }
  });

  it("defaults to webhook when args are empty and the field is absent", async () => {
    const dir = make_temp_dir("gw-default");
    write_lich_config(dir, { providers: [{ kind: "ollama", name: "main", model: "kept" }] });
    const previous = process.cwd();
    process.chdir(dir);
    try {
      expect(await run_cli(["gateway"])).toBe(0);
      expect(gateway_run.fn).toHaveBeenCalledWith(expect.anything(), ["webhook"]);
    } finally {
      process.chdir(previous);
    }
  });
});
