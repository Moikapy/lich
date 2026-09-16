import { spawn } from "node:child_process";
import type { JsonSchemaObject } from "../../util/json_schema.js";
import { capture_errors, clamp_output, optional_string_arg } from "../guard.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";

const MAX_OUTPUT_CHARS = 2000;
const DEFAULT_TEST_COMMAND = "node node_modules/vitest/vitest.mjs run";

const parameters: JsonSchemaObject = {
  type: "object",
  properties: {
    filter: {
      type: "string",
      description: "Optional test-file filter appended to the test command (e.g. a vitest file filter)",
    },
  },
  additionalProperties: false,
};

/** Injectable subprocess runner: runs `command` in `cwd`, streams via on_chunk. */
export type TestCommandRunner = (
  command: string,
  cwd: string,
  on_chunk: (stream: "stdout" | "stderr", chunk: Buffer) => void,
) => Promise<{ exit_code: number }>;

/** Module-level mutex: one run_tests per process; concurrent calls fail closed. */
let busy = false;

/** Runner seam for tests; defaults to a bash -lc spawn (same as terminal). */
let run_test_command: TestCommandRunner = default_runner;

function default_runner(
  command: string,
  cwd: string,
  on_chunk: (stream: "stdout" | "stderr", chunk: Buffer) => void,
): Promise<{ exit_code: number }> {
  const child = spawn("bash", ["-lc", command], {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => on_chunk("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => on_chunk("stderr", chunk));
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ exit_code: code ?? -1 }));
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
  timeout_ms: 600000,
  execute: async (args, context: ToolContext) =>
    capture_errors(async () => {
      if (busy === true) {
        return { ok: false, output: "", error: "run_tests_busy" } satisfies ToolResult;
      }
      busy = true;
      try {
        const filter = optional_string_arg(args, "filter", "");
        const command = build_command(filter === "" ? undefined : filter, context.env);
        const streams = { stdout: "", stderr: "" };
        const on_chunk = (stream: "stdout" | "stderr", chunk: Buffer): void => {
          streams[stream] = streams[stream] + chunk.toString("utf8");
        };
        const outcome = await run_test_command(command, context.work_dir, on_chunk);
        const ok = outcome.exit_code === 0;
        return {
          ok,
          output: clamp_output(`${streams.stdout}${streams.stderr}\n[exit ${outcome.exit_code}]`, MAX_OUTPUT_CHARS),
          ...(ok ? {} : { error: "tests_failed" }),
        };
      } finally {
        busy = false;
      }
    }),
};