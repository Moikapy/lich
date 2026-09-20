/**
 * `lich mcp` edits work-dir config through write_lich_config.
 * No network and no Godot/Redot process.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run_cli } from "../src/cli.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const created: string[] = [];
const SECRET = "super-secret-token";

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

async function write_config(work_dir: string, config: Record<string, unknown>): Promise<void> {
  const dir = path.join(work_dir, ".lich");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

async function read_config(work_dir: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path.join(work_dir, ".lich", "config.json"), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function base_config(): Record<string, unknown> {
  return {
    providers: [{ kind: "ollama", name: "main", model: "kept" }],
    plugins: ["./examples/game_bridge/game_bridge.plugin.mjs"],
    gateway: { platforms: ["webhook"] },
  };
}

async function capture(argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await run_cli(argv);
    return { code, out };
  } finally {
    process.stdout.write = write;
  }
}

describe("lich mcp", () => {
  it("lists nothing when mcp_servers is missing", async () => {
    const work_dir = await temp_dir("mcp-list-empty");
    const missing = await capture(["--work-dir", work_dir, "mcp", "list"]);
    expect(missing).toEqual({ code: 0, out: "" });
    await write_config(work_dir, base_config());
    const present = await capture(["--work-dir", work_dir, "mcp", "list"]);
    expect(present).toEqual({ code: 0, out: "" });
  });

  it("adds a disabled redot catalog entry and keeps other keys", async () => {
    const work_dir = await temp_dir("mcp-add-catalog");
    const project = path.join(work_dir, "game");
    await write_config(work_dir, base_config());
    const added = await capture([
      "--work-dir", work_dir, "mcp", "add", "redot", "--project-path", project,
    ]);
    expect(added.code).toBe(0);
    expect(added.out).toContain("added redot disabled");
    const saved = await read_config(work_dir);
    expect(saved.providers).toEqual(base_config().providers);
    expect(saved.plugins).toEqual(base_config().plugins);
    expect(saved.gateway).toEqual(base_config().gateway);
    expect(saved.mcp_servers).toEqual({
      redot: {
        enabled: false,
        command: "redot",
        args: ["--headless", "--mcp-server", "--path", project],
      },
    });
    const listed = await capture(["--work-dir", work_dir, "mcp", "list"]);
    expect(listed.out).toBe("redot stdio false\n");
  });

  it("refuses a download command and does not change the file", async () => {
    const work_dir = await temp_dir("mcp-add-refuse");
    await write_config(work_dir, base_config());
    const before = await readFile(path.join(work_dir, ".lich", "config.json"), "utf8");
    await expect(run_cli([
      "--work-dir", work_dir, "mcp", "add", "notes", "--command", "npx", "--arg", "-y",
    ])).rejects.toThrow(/npx/);
    await expect(run_cli([
      "--work-dir", work_dir, "mcp", "add", "remote", "--url", "https://example.invalid/mcp",
    ])).rejects.toThrow(/loopback/);
    const after = await readFile(path.join(work_dir, ".lich", "config.json"), "utf8");
    expect(after).toBe(before);
  });

  it("enables, disables, and removes one entry without logging env", async () => {
    const work_dir = await temp_dir("mcp-edit");
    await write_config(work_dir, {
      ...base_config(),
      mcp_servers: {
        lab: {
          enabled: false,
          command: path.join(work_dir, "lab"),
          args: ["--stdio"],
          env: { LICH_SECRET: SECRET },
        },
      },
    });
    await expect(run_cli(["--work-dir", work_dir, "mcp", "enable", "missing"])).rejects.toThrow(/not found/);
    const enabled = await capture(["--work-dir", work_dir, "mcp", "enable", "lab"]);
    expect(enabled.out).toBe("enabled lab\n");
    expect(enabled.out).not.toContain(SECRET);
    const listed = await capture(["--work-dir", work_dir, "mcp", "list"]);
    expect(listed.out).toBe("lab stdio true\n");
    expect(listed.out).not.toContain(SECRET);
    const disabled = await capture(["--work-dir", work_dir, "mcp", "disable", "lab"]);
    expect(disabled.out).toBe("disabled lab\n");
    const saved = await read_config(work_dir);
    const servers = saved.mcp_servers as { lab: { enabled: boolean; env: { LICH_SECRET: string } } };
    expect(servers.lab.enabled).toBe(false);
    expect(servers.lab.env.LICH_SECRET).toBe(SECRET);
    const removed = await capture(["--work-dir", work_dir, "mcp", "remove", "lab"]);
    expect(removed.out).toBe("removed lab\n");
    const after = await read_config(work_dir);
    expect(after.providers).toEqual(base_config().providers);
    expect(after.plugins).toEqual(base_config().plugins);
    expect(after.gateway).toEqual(base_config().gateway);
    expect(after).not.toHaveProperty("mcp_servers");
    const empty = await capture(["--work-dir", work_dir, "mcp", "list"]);
    expect(empty).toEqual({ code: 0, out: "" });
  });

  it("falls back to LICH_MODEL when project config has only mcp_servers", async () => {
    const work_dir = await temp_dir("mcp-env-fallback");
    await write_config(work_dir, {
      mcp_servers: {
        lab: { enabled: false, command: "echo", args: ["hi"] },
      },
    });
    const saved_model = process.env.LICH_MODEL;
    const saved_kind = process.env.LICH_PROVIDER_KIND;
    const saved_key = process.env.ANTHROPIC_API_KEY;
    process.env.LICH_MODEL = "env-fallback-model";
    process.env.LICH_PROVIDER_KIND = "anthropic";
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const failure = await run_cli(["--work-dir", work_dir, "hi"]).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toMatch(/no model configured/);
      expect(String(failure)).toMatch(/api key|auth/i);
    } finally {
      if (saved_model === undefined) {
        delete process.env.LICH_MODEL;
      } else {
        process.env.LICH_MODEL = saved_model;
      }
      if (saved_kind === undefined) {
        delete process.env.LICH_PROVIDER_KIND;
      } else {
        process.env.LICH_PROVIDER_KIND = saved_kind;
      }
      if (saved_key === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = saved_key;
      }
    }
  });
});
