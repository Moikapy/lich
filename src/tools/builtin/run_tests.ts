import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { JsonSchemaObject } from "../../util/json_schema.js";
import {
  capture_errors,
  clamp_output,
  optional_number_arg,
  optional_string_arg,
  ToolTimeoutError,
  with_timeout,
} from "../guard.js";
import { kill_process_group, track_detached_child } from "../process_group.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { scrub_spawn_env } from "./terminal.js";

const MAX_OUTPUT_CHARS = 2000;
const DEFAULT_TEST_COMMAND = "node node_modules/vitest/vitest.mjs run";
const DEFAULT_TIMEOUT_MS = 600000;
const MAX_TIMEOUT_MS = 600000;

const parameters: JsonSchemaObject = {
  type: "object",
  properties: {
    filter: {
      type: "string",
      description: "Optional test-file filter appended to the test command (e.g. a vitest file filter)",
    },
    timeout_ms: {
      type: "number",
      description: "Kill the suite after this many ms (default 600000, max 600000)",
    },
  },
  additionalProperties: false,
};

/** Injectable subprocess runner: runs `command` in `cwd`, streams via on_chunk. */
export type TestCommandRunner = (
  command: string,
  cwd: string,
  on_chunk: (stream: "stdout" | "stderr", chunk: Buffer) => void,
  signal?: AbortSignal,
) => Promise<{ exit_code: number }>;

/** Module-level mutex: one run_tests per process; concurrent calls fail closed. */
let busy = false;

/** Runner seam for tests; defaults to a bash -lc spawn (same as terminal). */
let run_test_command: TestCommandRunner = default_runner;

function wire_kill(child: ChildProcess, signal?: AbortSignal): void {
  if (signal === undefined) {
    return;
  }
  signal.addEventListener("abort", () => kill_process_group(child, "SIGKILL"), { once: true });
}

function default_runner(
  command: string,
  cwd: string,
  on_chunk: (stream: "stdout" | "stderr", chunk: Buffer) => void,
  signal?: AbortSignal,
): Promise<{ exit_code: number }> {
  const child = spawn("bash", ["-lc", command], {
    cwd,
    env: scrub_spawn_env(process.env, {}),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  track_detached_child(child);
  child.stdout?.on("data", (chunk: Buffer) => on_chunk("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => on_chunk("stderr", chunk));
  wire_kill(child, signal);
  return new Promise((resolve) => {
    child.on("exit", (code) => resolve({ exit_code: code ?? -1 }));
    child.on("error", () => resolve({ exit_code: -1 }));
  });
}

/** One argv token for bash -lc; the operator command stays a shell string. */
function shell_quote(token: string): string {
  return `'${token.replaceAll("'", "'\\''")}'`;
}

function build_command(filter: string | undefined, env: Record<string, string>): string {
  const base = optional_string_arg(env, "LICH_TEST_COMMAND", DEFAULT_TEST_COMMAND);
  return filter === undefined ? base : `${base} ${shell_quote(filter)}`;
}

function clamp_timeout(raw: number): number {
  return Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(raw)));
}

/** Append chunk text until the output budget is exhausted. */
function append_clamped(current: string, chunk: Buffer, budget: number): string {
  if (current.length >= budget) {
    return current;
  }
  const next = current + chunk.toString("utf8");
  return next.length > budget ? next.slice(0, budget) : next;
}

/** Replace the subprocess runner (test seam only; tests restore after). */
export function set_test_command_runner(runner: TestCommandRunner): void {
  run_test_command = runner;
}

/** Restore the default spawn runner (test seam teardown). */
export function reset_test_command_runner(): void {
  run_test_command = default_runner;
}

export const run_tests_tool: Tool = {
  name: "run_tests",
  description:
    "Run the project's test suite via LICH_TEST_COMMAND (default: vitest) in work_dir and report a structured pass/fail result with clamped output.",
  parameters,
  timeout_ms: MAX_TIMEOUT_MS,
  execute: async (args, context: ToolContext) =>
    capture_errors(async () => {
      if (busy === true) {
        return { ok: false, output: "", error: "run_tests_busy" } satisfies ToolResult;
      }
      busy = true;
      try {
        const filter = optional_string_arg(args, "filter", "");
        if (filter.startsWith("-") === true) {
          return { ok: false, output: "", error: "invalid_filter: must not start with -" } satisfies ToolResult;
        }
        const timeout_ms = clamp_timeout(optional_number_arg(args, "timeout_ms", DEFAULT_TIMEOUT_MS));
        const command = build_command(filter === "" ? undefined : filter, context.env);
        const streams = { stdout: "", stderr: "" };
        const on_chunk = (stream: "stdout" | "stderr", chunk: Buffer): void => {
          streams[stream] = append_clamped(streams[stream], chunk, MAX_OUTPUT_CHARS);
        };
        let timed_out = false;
        let exit_code: number;
        try {
          const outcome = await with_timeout((timeout_signal) => {
            const signals = [timeout_signal];
            if (context.signal !== undefined) {
              signals.push(context.signal);
            }
            return run_test_command(command, context.work_dir, on_chunk, AbortSignal.any(signals));
          }, timeout_ms, "run_tests");
          exit_code = outcome.exit_code;
        } catch (err) {
          if (err instanceof ToolTimeoutError === true) {
            timed_out = true;
            exit_code = -1;
          } else {
            throw err;
          }
        }
        if (timed_out === true || context.signal?.aborted === true) {
          return {
            ok: false,
            output: clamp_output(`${streams.stdout}${streams.stderr}\n[exit ${exit_code}]`, MAX_OUTPUT_CHARS),
            error: timed_out === true ? "timeout" : "cancelled",
          } satisfies ToolResult;
        }
        const ok = exit_code === 0;
        return {
          ok,
          output: clamp_output(`${streams.stdout}${streams.stderr}\n[exit ${exit_code}]`, MAX_OUTPUT_CHARS),
          ...(ok ? {} : { error: "tests_failed" }),
        };
      } finally {
        busy = false;
      }
    }),
};
