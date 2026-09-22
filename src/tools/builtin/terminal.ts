import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { DEFAULT_GATEWAY_TOKEN_ENVS } from "../../gateway/token_env.js";
import type { JsonSchemaObject } from "../../util/json_schema.js";
import {
  capture_errors,
  clamp_output,
  optional_number_arg,
  require_string_arg,
  ToolTimeoutError,
  with_timeout,
} from "../guard.js";
import { kill_process_group } from "../process_group.js";
import type { Tool } from "../types.js";
import { SECRET_PATTERN } from "./env_get.js";

const MAX_STREAM_CHARS = 50000;
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 300000;

/** Well-known provider key env names (also match SECRET_PATTERN; listed for clarity). */
const PROVIDER_KEY_ENVS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "LICH_API_KEY"] as const;

const parameters: JsonSchemaObject = {
  type: "object",
  properties: {
    command: { type: "string", description: "Shell command to run via bash -lc" },
    timeout_ms: { type: "number", description: "Kill the command after this many ms (default 60000, max 300000)" },
  },
  required: ["command"],
  additionalProperties: false,
};

function stream_chunk(current: { text: string }, chunk: Buffer): void {
  if (current.text.length >= MAX_STREAM_CHARS) {
    return;
  }
  current.text = current.text + chunk.toString("utf8");
  if (current.text.length > MAX_STREAM_CHARS) {
    current.text = current.text.slice(0, MAX_STREAM_CHARS);
  }
}

function clamp_timeout(raw: number): number {
  return Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(raw)));
}

interface RunOutcome {
  output: string;
  exit_code: number;
  timed_out: boolean;
  cancelled: boolean;
}

/**
 * Drop secret-ish names (env_get pattern), gateway token envs, and common
 * provider api_key_env names before spawning a shell.
 */
export function scrub_spawn_env(
  process_env: NodeJS.ProcessEnv,
  context_env: Record<string, string>,
): Record<string, string> {
  const drop = new Set<string>([...Object.values(DEFAULT_GATEWAY_TOKEN_ENVS), ...PROVIDER_KEY_ENVS]);
  const merged: Record<string, string | undefined> = { ...process_env, ...context_env };
  const scrubbed: Record<string, string> = {};
  for (const [name, value] of Object.entries(merged)) {
    if (value === undefined) {
      continue;
    }
    if (drop.has(name) === true || SECRET_PATTERN.test(name) === true) {
      continue;
    }
    scrubbed[name] = value;
  }
  return scrubbed;
}

function wire_kill(child: ChildProcess, timeout_signal: AbortSignal, external?: AbortSignal): void {
  const kill = (): void => kill_process_group(child, "SIGKILL");
  timeout_signal.addEventListener("abort", kill, { once: true });
  external?.addEventListener("abort", kill, { once: true });
}

function wait_exit(child: ChildProcess): Promise<number> {
  return new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? -1));
    child.on("error", () => resolve(-1));
  });
}

async function run_command(
  command: string,
  work_dir: string,
  env: Record<string, string>,
  timeout_ms: number,
  external?: AbortSignal,
): Promise<RunOutcome> {
  const stdout = { text: "" };
  const stderr = { text: "" };
  const child = spawn("bash", ["-lc", command], {
    cwd: work_dir,
    env: scrub_spawn_env(process.env, env),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => stream_chunk(stdout, chunk));
  child.stderr?.on("data", (chunk: Buffer) => stream_chunk(stderr, chunk));
  const exit_promise = wait_exit(child);
  let timed_out = false;
  let exit_code: number;
  try {
    exit_code = await with_timeout((timeout_signal) => {
      wire_kill(child, timeout_signal, external);
      return exit_promise;
    }, timeout_ms, "terminal");
  } catch (err) {
    if (err instanceof ToolTimeoutError === true) {
      timed_out = true;
      kill_process_group(child, "SIGKILL");
      exit_code = await exit_promise;
    } else {
      throw err;
    }
  }
  const output = `${stdout.text}${stderr.text}\n[exit ${exit_code}]`;
  return { output, exit_code, timed_out, cancelled: external?.aborted === true };
}

function terminal_result(outcome: RunOutcome): { ok: boolean; output: string; error?: string } {
  const result: { ok: boolean; output: string; error?: string } = {
    ok: outcome.exit_code === 0 && outcome.cancelled === false && outcome.timed_out === false,
    output: clamp_output(outcome.output),
  };
  if (outcome.cancelled === true) {
    result.error = "cancelled";
  } else if (outcome.timed_out === true) {
    result.error = "timeout";
  }
  return result;
}

export const terminal_tool: Tool = {
  name: "terminal",
  description: "Run a shell command with bash -lc and capture combined stdout/stderr plus the exit code.",
  parameters,
  timeout_ms: MAX_TIMEOUT_MS,
  execute: async (args, context) =>
    capture_errors(async () => {
      const command = require_string_arg(args, "command");
      const timeout_ms = clamp_timeout(optional_number_arg(args, "timeout_ms", DEFAULT_TIMEOUT_MS));
      const outcome = await run_command(command, context.work_dir, context.env, timeout_ms, context.signal);
      return terminal_result(outcome);
    }),
};
