/**
 * CLI --resume: parse_args, non-TUI rejection, and tui --resume → run_tui wiring.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../src/providers/types.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const tui_run = vi.hoisted(() => ({
  calls: [] as Array<{
    config: { session_dir?: string };
    options?: { initial_history?: readonly Message[]; resumed_id?: string };
  }>,
}));

vi.mock("ink", () => ({
  render: () => ({ waitUntilExit: () => Promise.resolve() }),
}));

vi.mock("../src/tui.js", () => ({
  run_tui: async (
    config: { session_dir?: string },
    options?: { initial_history?: readonly Message[]; resumed_id?: string },
  ) => {
    tui_run.calls.push({ config, options });
    return 0;
  },
}));

const read_spy = vi.hoisted(() => ({ fail_read_enoent: false }));

vi.mock("../src/session/store.js", async (import_original) => {
  const actual = await import_original<typeof import("../src/session/store.js")>();
  return {
    ...actual,
    read_session_messages: (file_path: string) => {
      if (read_spy.fail_read_enoent === true) {
        return Promise.reject(
          Object.assign(new Error("ENOENT: no such file or directory, open '" + file_path + "'"), {
            code: "ENOENT",
          }),
        );
      }
      return actual.read_session_messages(file_path);
    },
  };
});

import { parse_args, run_cli } from "../src/cli.js";

const created: string[] = [];

async function make_temp_dir(prefix: string): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(path.join(TMP_BASE, `${prefix}-`));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  tui_run.calls = [];
});

describe("parse_args --resume", () => {
  it("accepts --resume with a value", () => {
    expect(parse_args(["--resume", "latest"]).resume).toBe("latest");
    expect(parse_args(["tui", "--resume", "abc-1"]).resume).toBe("abc-1");
  });

  it("requires a value for --resume", () => {
    expect(() => parse_args(["--resume"])).toThrow("--resume requires a value");
  });

  it("includes --resume in usage via --help path", async () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await run_cli(["--help"])).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(chunks.join("")).toMatch(/--resume <id\|latest>/);
  });
});

describe("run_cli --resume mode guard", () => {
  it("rejects --resume outside TUI for agent and utility commands", async () => {
    await expect(run_cli(["--resume", "latest", "say hi"])).rejects.toThrow(
      "--resume is only supported in TUI mode (not one-shot)",
    );
    await expect(run_cli(["chat", "--resume", "latest"])).rejects.toThrow(
      "--resume is only supported in TUI mode (not chat)",
    );
    await expect(run_cli(["gateway", "--resume", "x"])).rejects.toThrow(
      "--resume is only supported in TUI mode (not gateway)",
    );
    await expect(run_cli(["serve", "--resume", "latest"])).rejects.toThrow(
      "--resume is only supported in TUI mode (not serve)",
    );
    await expect(run_cli(["init", "--resume", "latest"])).rejects.toThrow(
      "--resume is only supported in TUI mode (not init)",
    );
    await expect(run_cli(["config", "--resume", "latest"])).rejects.toThrow(
      "--resume is only supported in TUI mode (not config)",
    );
    await expect(run_cli(["mcp", "list", "--resume", "latest"])).rejects.toThrow(
      "--resume is only supported in TUI mode (not mcp)",
    );
    await expect(run_cli(["update", "--resume", "latest"])).rejects.toThrow(
      "--resume is only supported in TUI mode (not update)",
    );
  });
});

describe("run_cli tui --resume", () => {
  it("resolves a transcript and calls run_tui with initial_history and resumed_id", async () => {
    // Phase 1 gap: seeding into agent.run is not driven here; covered via this run_tui mock.
    const work_dir = await make_temp_dir("cli-resume");
    const session_dir = path.join(work_dir, "sessions");
    await mkdir(session_dir, { recursive: true });
    const transcript = path.join(session_dir, "abc-1.jsonl");
    const lines = [
      JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", kind: "message", message: { role: "system", content: "sys" } }),
      JSON.stringify({ ts: "2026-01-01T00:00:01.000Z", kind: "message", message: { role: "user", content: "hello" } }),
      JSON.stringify({ ts: "2026-01-01T00:00:02.000Z", kind: "message", message: { role: "assistant", content: "hi" } }),
    ];
    await writeFile(transcript, `${lines.join("\n")}\n`, "utf8");

    const code = await run_cli([
      "tui",
      "--resume",
      "abc-1",
      "--model",
      "mock-model",
      "--work-dir",
      work_dir,
      "--session-dir",
      session_dir,
    ]);
    expect(code).toBe(0);
    expect(tui_run.calls).toHaveLength(1);
    const call = tui_run.calls[0]!;
    expect(call.config.session_dir).toBe(session_dir);
    expect(call.options?.resumed_id).toBe("abc-1");
    expect(call.options?.initial_history).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it("maps a read-path ENOENT to session not found without leaking the path", async () => {
    const work_dir = await make_temp_dir("cli-resume-enoent");
    const session_dir = path.join(work_dir, "sessions");
    await mkdir(session_dir, { recursive: true });
    const transcript = path.join(session_dir, "gone-1.jsonl");
    await writeFile(transcript, "", "utf8");

    read_spy.fail_read_enoent = true;
    try {
      const error = await run_cli([
        "tui",
        "--resume",
        "gone-1",
        "--model",
        "mock-model",
        "--work-dir",
        work_dir,
        "--session-dir",
        session_dir,
      ]).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("session not found");
      expect(message).not.toContain(session_dir);
      expect(message).not.toContain("ENOENT");
    } finally {
      read_spy.fail_read_enoent = false;
    }
  });
});
