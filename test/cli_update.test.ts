/**
 * `lich update` decides whether to spawn npm. Lookup and install are injected
 * so these tests never hit the network or run npm.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detect_install_kind,
  run_lich_update,
  type CommandResult,
  type CommandRunner,
  type InstallKind,
  type UpdateIo,
} from "../src/cli_update.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const created: string[] = [];

interface RecordedCall {
  command: string;
  args: string[];
}

function make_temp_dir(prefix: string): string {
  mkdirSync(TMP_BASE, { recursive: true });
  const dir = mkdtempSync(path.join(TMP_BASE, `${prefix}-`));
  created.push(dir);
  return dir;
}

function capture_io(): UpdateIo & { stdout: string; stderr: string } {
  const io = {
    stdout: "",
    stderr: "",
    write_stdout(text: string) {
      io.stdout += text;
    },
    write_stderr(text: string) {
      io.stderr += text;
    },
  };
  return io;
}

function recording_runner(view: CommandResult, install: CommandResult = { exit_code: 0, stdout: "", stderr: "" }): {
  calls: RecordedCall[];
  run_command: CommandRunner;
} {
  const calls: RecordedCall[] = [];
  const run_command: CommandRunner = async (command, args) => {
    calls.push({ command, args: [...args] });
    return args[0] === "view" ? view : install;
  };
  return { calls, run_command };
}

function install_calls(calls: RecordedCall[]): string[][] {
  return calls.filter((call) => call.args[0] === "install").map((call) => [call.command, ...call.args]);
}

async function run_update_case(
  installed_version: string,
  view: CommandResult,
  install_kind: InstallKind = "npm",
  install?: CommandResult,
): Promise<{ code: number; stdout: string; stderr: string; calls: RecordedCall[] }> {
  const io = capture_io();
  const recorded = recording_runner(view, install);
  const code = await run_lich_update({
    installed_version,
    install_kind,
    run_command: recorded.run_command,
    write_stdout: io.write_stdout,
    write_stderr: io.write_stderr,
  });
  return { code, stdout: io.stdout, stderr: io.stderr, calls: recorded.calls };
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("lich update", () => {
  it("does not spawn install when the registry version matches", async () => {
    const result = await run_update_case("0.4.0", { exit_code: 0, stdout: "0.4.0\n", stderr: "" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("lich 0.4.0 is up to date");
    expect(install_calls(result.calls)).toEqual([]);
    expect(result.calls).toEqual([{ command: "npm", args: ["view", "@moikapy/lich", "version"] }]);
  });

  it("does not spawn install when the installed version is newer", async () => {
    const result = await run_update_case("0.5.0", { exit_code: 0, stdout: "0.4.0\n", stderr: "" });
    expect(result.code).toBe(0);
    expect(install_calls(result.calls)).toEqual([]);
  });

  it("spawns npm install -g @moikapy/lich@latest when the registry is newer", async () => {
    const result = await run_update_case("0.4.0", { exit_code: 0, stdout: "0.5.0\n", stderr: "" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("lich 0.4.0 -> 0.5.0");
    expect(result.stdout).toContain("Exit any running `lich tui` or `lich gateway` first");
    expect(install_calls(result.calls)).toEqual([["npm", "install", "-g", "@moikapy/lich@latest"]]);
  });

  it("does not install when the version lookup fails", async () => {
    const result = await run_update_case("0.4.0", {
      exit_code: 1,
      stdout: "",
      stderr: "npm ERR! ENOTFOUND registry.npmjs.org",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("could not read the registry version of @moikapy/lich");
    expect(result.stderr).toContain("ENOTFOUND");
    expect(install_calls(result.calls)).toEqual([]);
  });

  it("does not install when npm is missing from PATH", async () => {
    const result = await run_update_case("0.4.0", {
      exit_code: 127,
      stdout: "",
      stderr: "spawn npm ENOENT",
      error_code: "ENOENT",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("npm is not on PATH");
    expect(install_calls(result.calls)).toEqual([]);
  });

  it("reports a permission failure and does not retry the install", async () => {
    const result = await run_update_case(
      "0.4.0",
      { exit_code: 0, stdout: "0.5.0\n", stderr: "" },
      "npm",
      { exit_code: 243, stdout: "", stderr: "npm ERR! Error: EACCES: permission denied, mkdir '/usr/lib/node_modules'" },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("permission denied");
    expect(install_calls(result.calls)).toEqual([["npm", "install", "-g", "@moikapy/lich@latest"]]);
  });

  it("hints git pull for a clone and does not look up or install", async () => {
    const result = await run_update_case("0.4.0", { exit_code: 0, stdout: "9.9.9\n", stderr: "" }, "git");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("git pull");
    expect(result.calls).toEqual([]);
  });

  it("hints that npx cannot persist an update and does not install", async () => {
    const result = await run_update_case("0.4.0", { exit_code: 0, stdout: "9.9.9\n", stderr: "" }, "npx");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("npx");
    expect(result.calls).toEqual([]);
  });
});

describe("detect_install_kind", () => {
  it("treats a checkout with .git as a git clone", () => {
    const root = make_temp_dir("git-clone");
    mkdirSync(path.join(root, ".git"));
    const entry = path.join(root, "src", "cli.ts");
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, "");
    expect(detect_install_kind(entry, {}, (dir) => dir === root)).toBe("git");
  });

  it("treats npm global lib/node_modules as npm even under a git parent", () => {
    const root = make_temp_dir("npm-global");
    mkdirSync(path.join(root, ".git"));
    const entry = path.join(root, "lib", "node_modules", "@moikapy", "lich", "dist", "cli.js");
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, "");
    expect(detect_install_kind(entry, {}, (dir) => existsSync(path.join(dir, ".git")))).toBe("npm");
  });

  it("treats a project-local node_modules copy as local, not npm global", () => {
    const root = make_temp_dir("npm-local");
    const entry = path.join(root, "node_modules", "@moikapy", "lich", "dist", "cli.js");
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, "");
    expect(detect_install_kind(entry, {}, () => false)).toBe("local");
  });

  it("treats a project-local node_modules copy under a git repo as local", () => {
    const root = make_temp_dir("local-in-git");
    mkdirSync(path.join(root, ".git"));
    const entry = path.join(root, "node_modules", "@moikapy", "lich", "dist", "cli.js");
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, "");
    expect(detect_install_kind(entry, {}, (dir) => existsSync(path.join(dir, ".git")))).toBe("local");
  });

  it("treats a bun global path as local so npm install -g is not run", () => {
    const root = make_temp_dir("bun-global");
    const entry = path.join(root, ".bun", "install", "global", "node_modules", "@moikapy", "lich", "dist", "cli.js");
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, "");
    expect(detect_install_kind(entry, {}, () => false)).toBe("local");
  });

  it("treats an npx cache path or npm_command=exec as npx", () => {
    const root = make_temp_dir("npx");
    const entry = path.join(root, "_npx", "abc", "node_modules", "@moikapy", "lich", "dist", "cli.js");
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, "");
    expect(detect_install_kind(entry, {}, () => true)).toBe("npx");
    expect(detect_install_kind(path.join(root, "dist", "cli.js"), { npm_command: "exec" }, () => false)).toBe("npx");
  });
});

describe("lich update local install", () => {
  it("hints without looking up or installing for a local install kind", async () => {
    const result = await run_update_case("0.4.0", { exit_code: 0, stdout: "9.9.9\n", stderr: "" }, "local");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not an npm global install");
    expect(result.calls).toEqual([]);
  });
});
