/**
 * Argv + boot-line helpers for spawning `lich serve` from Electron.
 */
import { existsSync } from "node:fs";
import path from "node:path";

export const DEFAULT_SERVE_HOST = "127.0.0.1";
export const DEFAULT_SERVE_PORT = 0;

export interface ServeBootInfo {
  port: number;
  token: string;
}

export interface BackendCommand {
  command: string;
  args: string[];
  cwd: string;
}

export interface BackendCommandOptions {
  /** Monorepo root that contains `src/cli.ts`. */
  repo_root: string;
  /** Agent work directory (`.lich/config.json`). Defaults to `repo_root`. */
  work_dir?: string;
  host?: string;
  port?: number;
  /** Use installed `lich` bin instead of `bun src/cli.ts`. */
  prefer_packaged?: boolean;
}

export function resolve_repo_root_from_electron_dir(electron_dir: string): string {
  // apps/ossuary/dist/electron → repo root
  return path.resolve(electron_dir, "../../../..");
}

export function build_serve_command(options: BackendCommandOptions): BackendCommand {
  const host = options.host ?? DEFAULT_SERVE_HOST;
  const port = options.port ?? DEFAULT_SERVE_PORT;
  const work_dir = options.work_dir ?? options.repo_root;
  const serve_args = [
    "serve",
    "--host",
    host,
    "--port",
    String(port),
    "--work-dir",
    work_dir,
  ];

  if (options.prefer_packaged === true) {
    return { command: "lich", args: serve_args, cwd: work_dir };
  }

  const cli_ts = path.join(options.repo_root, "src", "cli.ts");
  if (existsSync(cli_ts) === false) {
    throw new Error(`lich cli not found at ${cli_ts}`);
  }
  return {
    command: "bun",
    args: [cli_ts, ...serve_args],
    cwd: work_dir,
  };
}

export function parse_serve_boot_line(line: string): ServeBootInfo {
  const trimmed = line.trim();
  let parsed: { port?: unknown; token?: unknown };
  try {
    parsed = JSON.parse(trimmed) as { port?: unknown; token?: unknown };
  } catch {
    throw new Error("invalid serve boot JSON");
  }
  if (typeof parsed.port !== "number" || Number.isInteger(parsed.port) === false || parsed.port <= 0) {
    throw new Error("invalid serve boot port");
  }
  if (typeof parsed.token !== "string" || parsed.token.length === 0) {
    throw new Error("invalid serve boot token");
  }
  return { port: parsed.port, token: parsed.token };
}

export function build_ws_url(boot: ServeBootInfo, host = DEFAULT_SERVE_HOST): string {
  return `ws://${host}:${boot.port}/?token=${encodeURIComponent(boot.token)}`;
}

export function extract_boot_from_stdout(
  chunk: string,
  buffer: string,
): { buffer: string; boot?: ServeBootInfo } {
  const next = buffer + chunk;
  const lines = next.split("\n");
  const incomplete = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim().startsWith("{") === false) {
      continue;
    }
    return { buffer: incomplete, boot: parse_serve_boot_line(line) };
  }
  return { buffer: incomplete };
}
