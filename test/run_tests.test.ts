import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { ToolExecutor } from "../src/tools/executor.js";
import { register_builtin_tools } from "../src/tools/builtin/index.js";
import { reset_test_command_runner, set_test_command_runner } from "../src/tools/builtin/run_tests.js";
import type { TestCommandRunner } from "../src/tools/builtin/run_tests.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

let tmp_root: string;
let executor: ToolExecutor;

/** Recorded runner invocation: the command and cwd it was handed. */
interface RecordedCall {
  command: string;
  cwd: string;
}

/** Runner that records invocations and replies with a canned exit code + chunks. */
function recording_runner(
  reply: { exit_code: number; stdout?: string; stderr?: string },
): { calls: RecordedCall[]; runner: TestCommandRunner } {
  const calls: RecordedCall[] = [];
  const runner: TestCommandRunner = async (command, cwd, on_chunk) => {
    calls.push({ command, cwd });
    if (reply.stdout !== undefined) {
      on_chunk("stdout", Buffer.from(reply.stdout));
    }
    if (reply.stderr !== undefined) {
      on_chunk("stderr", Buffer.from(reply.stderr));
    }
    return { exit_code: reply.exit_code };
  };
  return { calls, runner };
}

beforeEach(async () => {
  await mkdtemp(path.join(TMP_BASE, "run-tests-")).then((dir) => {
    tmp_root = dir;
  });
  const registry = new ToolRegistry();
  register_builtin_tools(registry);
  executor = new ToolExecutor(registry);
});

afterEach(() => {
  reset_test_command_runner();
});

describe("run_tests", () => {
  it("reports a green suite with structured ok and clamped output", async () => {
    const { calls, runner } = recording_runner({ exit_code: 0, stdout: "all good\n" });
    set_test_command_runner(runner);
    const result = await executor.execute("run_tests", {}, { work_dir: tmp_root, env: {} });
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.output).toContain("all good");
    expect(result.output).toContain("[exit 0]");
    expect(calls[0]?.cwd).toBe(tmp_root);
  });

  it("fails closed on a nonzero exit code with the tests_failed error", async () => {
    const { runner } = recording_runner({ exit_code: 1, stderr: "1 failed\n" });
    set_test_command_runner(runner);
    const result = await executor.execute("run_tests", {}, { work_dir: tmp_root, env: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("tests_failed");
    expect(result.output).toContain("1 failed");
    expect(result.output).toContain("[exit 1]");
  });

  it("honors LICH_TEST_COMMAND from the context env map", async () => {
    const { calls, runner } = recording_runner({ exit_code: 0 });
    set_test_command_runner(runner);
    await executor.execute("run_tests", {}, { work_dir: tmp_root, env: { LICH_TEST_COMMAND: "bun test" } });
    expect(calls[0]?.command).toBe("bun test");
  });

  it("uses the vitest default when LICH_TEST_COMMAND is unset", async () => {
    const { calls, runner } = recording_runner({ exit_code: 0 });
    set_test_command_runner(runner);
    await executor.execute("run_tests", {}, { work_dir: tmp_root, env: {} });
    expect(calls[0]?.command).toContain("node_modules/vitest/vitest.mjs run");
  });

  it("rejects filters that start with a dash", async () => {
    const { calls, runner } = recording_runner({ exit_code: 0 });
    set_test_command_runner(runner);
    const result = await executor.execute("run_tests", { filter: "--help" }, { work_dir: tmp_root, env: {} });
    expect(result.ok).toBe(false);
    expect(result.error?.startsWith("invalid_filter")).toBe(true);
    expect(calls.length).toBe(0);
  });

  it("appends the filter argument to the command", async () => {
    const { calls, runner } = recording_runner({ exit_code: 0 });
    set_test_command_runner(runner);
    await executor.execute("run_tests", { filter: "test/loop.test.ts" }, { work_dir: tmp_root, env: {} });
    expect(calls[0]?.command).toContain("vitest.mjs run 'test/loop.test.ts'");
  });

  it("quotes the filter so a semicolon cannot start a second statement", async () => {
    const marker = path.join(tmp_root, "breakout");
    const { calls, runner } = recording_runner({ exit_code: 0 });
    set_test_command_runner(runner);
    await executor.execute("run_tests", { filter: `; touch ${marker}` }, { work_dir: tmp_root, env: { LICH_TEST_COMMAND: "true" } });
    const command = calls[0]?.command ?? "";
    expect(command).toBe(`true '; touch ${marker}'`);
    const probed = spawnSync("bash", ["-lc", command], { cwd: tmp_root });
    expect(probed.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("runs in context.work_dir, not process.cwd()", async () => {
    const { calls, runner } = recording_runner({ exit_code: 0 });
    set_test_command_runner(runner);
    await executor.execute("run_tests", {}, { work_dir: tmp_root, env: {} });
    expect(calls[0]?.cwd).toBe(tmp_root);
    expect(calls[0]?.cwd).not.toBe(process.cwd());
  });

  it("fails closed with run_tests_busy while another run holds the mutex", async () => {
    let release: (() => void) | undefined;
    const slow_runner: TestCommandRunner = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { exit_code: 0 };
    };
    set_test_command_runner(slow_runner);
    const first = executor.execute("run_tests", {}, { work_dir: tmp_root, env: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await executor.execute("run_tests", {}, { work_dir: tmp_root, env: {} });
    expect(second.ok).toBe(false);
    expect(second.error).toBe("run_tests_busy");
    release?.();
    const first_result = await first;
    expect(first_result.ok).toBe(true);
  });

  it("clamps output to the 2000-char budget (content plus a truncation marker)", async () => {
    const long = "x".repeat(5000);
    const { runner } = recording_runner({ exit_code: 0, stdout: long });
    set_test_command_runner(runner);
    const result = await executor.execute("run_tests", {}, { work_dir: tmp_root, env: {} });
    expect(result.output.startsWith("x".repeat(2000))).toBe(true);
    expect(result.output).toContain("truncated");
  });
});