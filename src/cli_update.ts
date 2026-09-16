/**
 * `lich update`: compare the installed version to the npm registry and,
 * when newer, shell out to `npm install -g @moikapy/lich@latest`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { LICH_VERSION } from "./index.js";

export const PACKAGE_NAME = "@moikapy/lich";
export const VIEW_ARGS = ["view", PACKAGE_NAME, "version"] as const;
export const INSTALL_ARGS = ["install", "-g", `${PACKAGE_NAME}@latest`] as const;

export type InstallKind = "npm" | "git" | "npx";

export interface CommandResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  error_code?: string;
}

export type CommandRunner = (command: string, args: readonly string[]) => Promise<CommandResult>;

export interface UpdateIo {
  write_stdout: (text: string) => void;
  write_stderr: (text: string) => void;
}

export interface UpdateRequest extends UpdateIo {
  installed_version: string;
  install_kind: InstallKind;
  run_command: CommandRunner;
}

type Semver = [number, number, number, string];
type VersionRelation = "update" | "current" | "invalid";

const NPM_MISSING =
  "lich: npm is not on PATH. Install Node.js, or run `npm install -g @moikapy/lich@latest` once npm is available.\n";
const EXIT_FIRST_HINT =
  "Exit any running `lich tui` or `lich gateway` first — npm cannot replace the package while those processes are running.\n";

function parse_semver(version: string): Semver | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version.trim());
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ""];
}

/** `update` when the registry version is strictly newer than the installed one. */
export function version_relation(installed: string, registry: string): VersionRelation {
  const left = parse_semver(installed);
  const right = parse_semver(registry);
  if (left === null || right === null) {
    return "invalid";
  }
  for (let index = 0; index < 3; index += 1) {
    const installed_part = left[index];
    const registry_part = right[index];
    if (typeof installed_part !== "number" || typeof registry_part !== "number") {
      return "invalid";
    }
    if (installed_part < registry_part) {
      return "update";
    }
    if (installed_part > registry_part) {
      return "current";
    }
  }
  if (left[3] !== "" && right[3] === "") {
    return "update";
  }
  return "current";
}

/** npm global, a git clone (`git pull`), or an npx temporary copy. */
export function detect_install_kind(
  module_path: string,
  env: NodeJS.ProcessEnv,
  has_git: (dir: string) => boolean,
): InstallKind {
  if (env.npm_command === "exec" || module_path.includes(`${path.sep}_npx${path.sep}`)) {
    return "npx";
  }
  let dir = path.dirname(path.resolve(module_path));
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (path.basename(dir) === "node_modules") {
      return "npm";
    }
    if (has_git(dir) === true) {
      return "git";
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return "npm";
}

function blocked_install_message(kind: InstallKind): string | null {
  if (kind === "git") {
    return "lich: this copy is a git clone, not an npm install. Update with `git pull` in the repository.\n";
  }
  if (kind === "npx") {
    return "lich: npx runs a temporary copy and cannot persist an update. Install with `npm install -g @moikapy/lich`.\n";
  }
  return null;
}

function registry_version(viewed: CommandResult, request: UpdateRequest): string | null {
  if (viewed.error_code === "ENOENT") {
    request.write_stderr(NPM_MISSING);
    return null;
  }
  if (viewed.exit_code !== 0) {
    const detail = viewed.stderr.trim() || viewed.stdout.trim() || `exit ${viewed.exit_code}`;
    request.write_stderr(`lich: could not read the registry version of ${PACKAGE_NAME}: ${detail}\n`);
    return null;
  }
  const registry = viewed.stdout.trim();
  if (parse_semver(registry) === null) {
    request.write_stderr(`lich: could not read the registry version of ${PACKAGE_NAME}: unexpected version "${registry}"\n`);
    return null;
  }
  return registry;
}

function is_permission_failure(installed: CommandResult): boolean {
  if (installed.error_code === "EACCES" || installed.error_code === "EPERM") {
    return true;
  }
  const text = `${installed.stderr}\n${installed.stdout}`.toLowerCase();
  return text.includes("eacces") || text.includes("eperm") || text.includes("permission denied");
}

function report_install(request: UpdateRequest, installed: CommandResult): number {
  if (installed.exit_code === 0) {
    request.write_stdout(`updated ${PACKAGE_NAME}. Run \`lich --version\` in a new shell to confirm.\n`);
    return 0;
  }
  if (installed.error_code === "ENOENT") {
    request.write_stderr(NPM_MISSING);
    return 1;
  }
  if (is_permission_failure(installed) === true) {
    request.write_stderr("lich: npm install failed (permission denied). Use a writable npm prefix, or run `npm install -g @moikapy/lich@latest` yourself.\n");
    return 1;
  }
  const detail = installed.stderr.trim() || `exit ${installed.exit_code}`;
  request.write_stderr(`lich: npm install failed: ${detail}\n`);
  return 1;
}

async function install_if_newer(request: UpdateRequest, registry: string): Promise<number> {
  const relation = version_relation(request.installed_version, registry);
  if (relation === "invalid") {
    request.write_stderr(`lich: could not compare versions (installed ${request.installed_version}, registry ${registry})\n`);
    return 1;
  }
  if (relation !== "update") {
    request.write_stdout(`lich ${request.installed_version} is up to date\n`);
    return 0;
  }
  request.write_stdout(`lich ${request.installed_version} -> ${registry}\n`);
  request.write_stdout(EXIT_FIRST_HINT);
  const installed = await request.run_command("npm", INSTALL_ARGS);
  return report_install(request, installed);
}

/** Decide whether to install. Tests inject `run_command` so neither lookup nor install hits the network. */
export async function run_lich_update(request: UpdateRequest): Promise<number> {
  const blocked = blocked_install_message(request.install_kind);
  if (blocked !== null) {
    request.write_stderr(blocked);
    return 1;
  }
  const viewed = await request.run_command("npm", VIEW_ARGS);
  const registry = registry_version(viewed, request);
  if (registry === null) {
    return 1;
  }
  return install_if_newer(request, registry);
}

/** Default spawn. Forwards only `npm install` output; `npm view` stays quiet. */
export function default_command_runner(command: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled === true) {
        return;
      }
      settled = true;
      resolve(result);
    };
    const forward = args[0] === "install";
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (forward === true) {
        process.stdout.write(text);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (forward === true) {
        process.stderr.write(text);
      }
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ exit_code: 127, stdout, stderr: error.message, error_code: error.code });
    });
    child.on("close", (code) => {
      finish({ exit_code: code ?? 1, stdout, stderr });
    });
  });
}

export async function run_update(module_path: string): Promise<number> {
  return run_lich_update({
    installed_version: LICH_VERSION,
    install_kind: detect_install_kind(module_path, process.env, (dir) => existsSync(path.join(dir, ".git"))),
    run_command: default_command_runner,
    write_stdout: (text) => {
      process.stdout.write(text);
    },
    write_stderr: (text) => {
      process.stderr.write(text);
    },
  });
}
