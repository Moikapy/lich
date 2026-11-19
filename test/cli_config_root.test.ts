/**
 * `--config` must be a JSON object. A bad root or a non-object provider
 * must fail before the TUI starts and must not echo file contents.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TMP_BASE } from "./helpers/tmp_base.js";

const tui_run = vi.hoisted(() => ({ calls: 0 }));

vi.mock("ink", () => ({
  render: () => ({ waitUntilExit: () => Promise.resolve() }),
}));

vi.mock("../src/tui.js", () => ({
  run_tui: async () => {
    tui_run.calls += 1;
    return 0;
  },
}));

import { parse_args, run_cli } from "../src/cli.js";

const created: string[] = [];
const SECRET = "sk-config-root-secret";

async function make_temp_dir(prefix: string): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(path.join(TMP_BASE, `${prefix}-`));
  created.push(dir);
  return dir;
}

async function rejection_of(argv: string[]): Promise<string> {
  try {
    await run_cli(argv);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("run_cli resolved");
}

afterEach(async () => {
  tui_run.calls = 0;
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("parse_args --config", () => {
  it("requires a path", () => {
    expect(() => parse_args(["tui", "--config"])).toThrow("--config requires a path");
    expect(() => parse_args(["--config"])).toThrow("--config requires a path");
  });
});

describe("run_cli --config", () => {
  it("rejects an array, null, or string root and does not echo a planted secret", async () => {
    const dir = await make_temp_dir("config-root");
    const array_path = path.join(dir, "array.json");
    const body = JSON.stringify([{ kind: "ollama", name: "main", model: "m", api_key: SECRET }]);
    await writeFile(array_path, body);

    const array_error = await rejection_of(["tui", "--config", array_path]);
    expect(array_error).toContain("lich tui:");
    expect(array_error).toContain("config root must be a JSON object");
    expect(array_error).not.toContain(SECRET);
    expect(await readFile(array_path, "utf8")).toBe(body);

    for (const raw of ["null", `"${SECRET}"`]) {
      const file = path.join(dir, `scalar-${raw.length}.json`);
      await writeFile(file, raw);
      const message = await rejection_of(["tui", "--config", file]);
      expect(message).toContain("config root must be a JSON object");
      expect(message).not.toContain(SECRET);
    }
    expect(tui_run.calls).toBe(0);
  });

  it("rejects a non-object providers[0] when a provider flag is set and leaves the file", async () => {
    const dir = await make_temp_dir("config-provider");
    const file = path.join(dir, "config.json");
    const body = `${JSON.stringify({ providers: ["not-an-object"], agent_name: "kept" })}\n`;
    await writeFile(file, body);

    const message = await rejection_of(["tui", "--config", file, "--model", "other"]);
    expect(message).toBe("lich tui: config providers[0] must be an object");
    expect(await readFile(file, "utf8")).toBe(body);

    const null_file = path.join(dir, "null-provider.json");
    const null_body = JSON.stringify({ providers: [null] });
    await writeFile(null_file, null_body);
    const chat_message = await rejection_of(["chat", "--config", null_file, "--model", "other"]);
    expect(chat_message).toBe("lich chat: config providers[0] must be an object");
    expect(await readFile(null_file, "utf8")).toBe(null_body);
    expect(tui_run.calls).toBe(0);
  });

  it("keeps one-shot failures unprefixed and does not open a directory as JSON", async () => {
    const dir = await make_temp_dir("config-oneshot");
    const array_path = path.join(dir, "array.json");
    await writeFile(array_path, "[]");
    const one_shot = await rejection_of(["--config", array_path, "say hi"]);
    expect(one_shot.startsWith("lich ")).toBe(false);
    expect(one_shot).toContain("config root must be a JSON object");

    await writeFile(path.join(dir, "keep.txt"), SECRET);
    const directory = await rejection_of(["tui", "--config", dir]);
    expect(directory).toContain("lich tui:");
    expect(directory).toContain("cannot use config file");
    expect(directory).not.toContain(SECRET);
    expect(await readFile(path.join(dir, "keep.txt"), "utf8")).toBe(SECRET);
    expect(tui_run.calls).toBe(0);
  });
});
