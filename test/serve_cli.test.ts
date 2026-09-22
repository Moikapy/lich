/**
 * CLI `lich serve`: flag parsing, wiring, and boot + health from a tiny client.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { LICH_VERSION } from "../src/index.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const serve_run = vi.hoisted(() => ({
  calls: [] as Array<{
    config: { session_dir?: string; work_dir?: string };
    options: { host?: string; port?: number };
  }>,
}));

vi.mock("../src/serve/server.js", async () => {
  const actual = await vi.importActual<typeof import("../src/serve/server.js")>("../src/serve/server.js");
  return {
    ...actual,
    run_serve: async (
      config: { session_dir?: string; work_dir?: string },
      options: { host?: string; port?: number } = {},
    ) => {
      serve_run.calls.push({ config, options });
      return 0;
    },
  };
});

import { parse_args, run_cli } from "../src/cli.js";

const created: string[] = [];
const children: ChildProcess[] = [];

async function make_temp_dir(prefix: string): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(path.join(TMP_BASE, `${prefix}-`));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  while (children.length > 0) {
    const child = children.pop();
    if (child !== undefined && child.killed !== true) {
      child.kill("SIGTERM");
    }
  }
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  serve_run.calls = [];
});

describe("parse_args serve flags", () => {
  it("parses --host and --port with serve", () => {
    const options = parse_args(["serve", "--host", "127.0.0.1", "--port", "0"]);
    expect(options.positionals).toEqual(["serve"]);
    expect(options.serve_flags).toEqual({ host: "127.0.0.1", port: 0 });
  });

  it("rejects --host / --port outside serve", () => {
    expect(() => parse_args(["chat", "--host", "127.0.0.1"])).toThrow("unknown flag: --host");
    expect(() => parse_args(["--port", "0"])).toThrow("unknown flag: --port");
  });

  it("rejects a bad --port", () => {
    expect(() => parse_args(["serve", "--port", "nope"])).toThrow(
      "--port must be an integer between 0 and 65535",
    );
  });
});

describe("run_cli serve wiring", () => {
  it("passes agent config and bind options to run_serve", async () => {
    const work_dir = await make_temp_dir("serve-cli-wire");
    const lich_dir = path.join(work_dir, ".lich");
    await mkdir(lich_dir, { recursive: true });
    await writeFile(
      path.join(lich_dir, "config.json"),
      JSON.stringify({
        providers: [{ kind: "ollama", name: "local", model: "unused" }],
        work_dir,
      }),
    );
    expect(await run_cli(["--work-dir", work_dir, "serve", "--port", "0", "--host", "127.0.0.1"])).toBe(0);
    expect(serve_run.calls).toHaveLength(1);
    expect(serve_run.calls[0]?.options).toEqual({ host: "127.0.0.1", port: 0 });
    expect(serve_run.calls[0]?.config.work_dir).toBe(work_dir);
    expect(serve_run.calls[0]?.config.session_dir).toBe(path.join(work_dir, ".lich", "sessions"));
  });

  it("lists serve in --help", async () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await run_cli(["--help"])).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    const help = chunks.join("");
    expect(help).toMatch(/lich serve/);
    expect(help).toMatch(/--host <addr>/);
    expect(help).toMatch(/--port <n>/);
  });
});

describe("bun src/cli.ts serve boot", () => {
  it("boots and answers health from a tiny client", async () => {
    const work_dir = await make_temp_dir("serve-cli-boot");
    const lich_dir = path.join(work_dir, ".lich");
    await mkdir(lich_dir, { recursive: true });
    await writeFile(
      path.join(lich_dir, "config.json"),
      JSON.stringify({
        providers: [{ kind: "ollama", name: "local", model: "unused" }],
        work_dir,
        log_level: "error",
      }),
    );
    const cli_path = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const child = spawn(
      "bun",
      [cli_path, "serve", "--work-dir", work_dir, "--port", "0", "--host", "127.0.0.1"],
      { cwd: work_dir, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    const boot = await read_boot_line(child);
    const result = await rpc_over_ws(boot.port, boot.token, {
      jsonrpc: "2.0",
      id: 1,
      method: "health",
      params: {},
    });
    expect(result).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { status: "ok", version: LICH_VERSION },
    });
    child.kill("SIGTERM");
    await wait_exit(child);
  }, 20_000);

  it("denies non-loopback --host", async () => {
    const work_dir = await make_temp_dir("serve-cli-deny");
    const lich_dir = path.join(work_dir, ".lich");
    await mkdir(lich_dir, { recursive: true });
    await writeFile(
      path.join(lich_dir, "config.json"),
      JSON.stringify({
        providers: [{ kind: "ollama", name: "local", model: "unused" }],
        work_dir,
        log_level: "error",
      }),
    );
    const cli_path = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const child = spawn(
      "bun",
      [cli_path, "serve", "--work-dir", work_dir, "--host", "0.0.0.0", "--port", "0"],
      { cwd: work_dir, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    const { code, stderr } = await wait_exit_with_output(child);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/loopback/);
  }, 20_000);
});

async function read_boot_line(child: ChildProcess): Promise<{ port: number; token: string }> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      reject(new Error(`serve boot timeout; stderr=${child.stderr?.read()?.toString() ?? ""}`));
    }, 15_000);
    const on_data = (chunk: Buffer | string): void => {
      buffer += String(chunk);
      const line = buffer.split("\n").find((entry) => entry.trim().startsWith("{") === true);
      if (line === undefined) {
        return;
      }
      clearTimeout(timer);
      child.stdout?.off("data", on_data);
      try {
        const parsed = JSON.parse(line) as { port?: unknown; token?: unknown };
        if (typeof parsed.port !== "number" || typeof parsed.token !== "string") {
          reject(new Error(`bad boot line: ${line}`));
          return;
        }
        resolve({ port: parsed.port, token: parsed.token });
      } catch (error) {
        reject(error);
      }
    };
    child.stdout?.on("data", on_data);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`serve exited early with code ${code}; stderr=${buffer}`));
    });
  });
}

async function rpc_over_ws(port: number, token: string, request: Record<string, unknown>): Promise<unknown> {
  const ws = await open_ws(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("rpc timeout")), 5000);
      ws.once("message", (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(String(data)));
      });
      ws.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      ws.send(JSON.stringify(request));
    });
  } finally {
    ws.close();
  }
}

function open_ws(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("websocket open timeout"));
    }, 5000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", () => {
      clearTimeout(timer);
      reject(new Error("websocket open failed"));
    });
  });
}

function wait_exit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
  });
}

function wait_exit_with_output(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("exit", (code) => {
      resolve({ code, stderr });
    });
  });
}
