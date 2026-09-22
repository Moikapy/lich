/**
 * Refuse downloaders, shells, and catalog pins before anything is spawned.
 * Footgun guard only — not a security boundary.
 */
import path from "node:path";

const SHELL_META = /[;&|`$<>]/;
const DOWNLOADERS = new Set([
  "npx",
  "npm",
  "bunx",
  "uvx",
  "curl",
  "wget",
  "pnpm",
  "yarn",
  "deno",
]);
const SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "csh",
  "tcsh",
  "ksh",
  "cmd",
  "cmd.exe",
  "powershell",
  "pwsh",
]);
const INTERPRETERS = new Set(["node", "nodejs", "python", "python3", "python2", "ruby", "perl", "php"]);
const EVAL_FLAGS = new Set(["-c", "-e", "--eval", "-Command", "-c ", "-EncodedCommand"]);

export interface McpEntryShape {
  command?: string;
  args?: readonly string[];
  url?: string;
}

function base_of(command: string): string {
  return path.basename(command).toLowerCase();
}

function refuse_eval_args(base: string, args: readonly string[]): string | undefined {
  if (INTERPRETERS.has(base) === false && base !== "bun") {
    return undefined;
  }
  for (const arg of args) {
    if (EVAL_FLAGS.has(arg) === true) {
      return `refused ${base} eval flag '${arg}'`;
    }
  }
  return undefined;
}

function refuse_bun_x(base: string, args: readonly string[]): string | undefined {
  if (base !== "bun") {
    return undefined;
  }
  const first = args[0];
  if (first === "x" || first === "exec") {
    return "refused bun x / bun exec";
  }
  return undefined;
}

function refuse_pkg_dlx(base: string, args: readonly string[]): string | undefined {
  if (base !== "pnpm" && base !== "yarn" && base !== "npm") {
    return undefined;
  }
  const first = args[0];
  if (first === "dlx" || first === "exec" || first === "create") {
    return `refused ${base} ${first}`;
  }
  return undefined;
}

function refuse_env_chain(args: readonly string[]): string | undefined {
  for (const arg of args) {
    if (arg.includes("=") === true) {
      continue;
    }
    const base = base_of(arg);
    if (DOWNLOADERS.has(base) === true || SHELLS.has(base) === true) {
      return `refused env → '${base}'`;
    }
    return undefined;
  }
  return undefined;
}

function refuse_arg_downloaders(args: readonly string[]): string | undefined {
  const limit = Math.min(args.length, 3);
  for (let index = 0; index < limit; index += 1) {
    const arg = args[index];
    if (arg === undefined || arg.startsWith("-") === true || arg.includes("=") === true) {
      continue;
    }
    const base = base_of(arg);
    if (DOWNLOADERS.has(base) === true) {
      return `refused download command '${base}' in args`;
    }
  }
  return undefined;
}

export function refuse_stdio_command(command: string, args: readonly string[] = []): string | undefined {
  if (command.includes("://") === true) {
    return "refused url; only a local binary is allowed";
  }
  if (SHELL_META.test(command) === true) {
    return "refused shell metacharacters in mcp command";
  }
  if (command.length === 0 || command.trim() !== command || /\s/.test(command) === true) {
    return "refused mcp command";
  }
  const base = base_of(command);
  if (DOWNLOADERS.has(base) === true) {
    return `refused download command '${base}'`;
  }
  if (SHELLS.has(base) === true) {
    return `refused shell '${base}'`;
  }
  if (base === "env") {
    return refuse_env_chain(args) ?? refuse_arg_downloaders(args);
  }
  return (
    refuse_bun_x(base, args) ??
    refuse_pkg_dlx(base, args) ??
    refuse_eval_args(base, args) ??
    refuse_arg_downloaders(args)
  );
}

export function refuse_stdio_arg(arg: string): string | undefined {
  if (arg.includes("://") === true) {
    return "refused url in mcp args";
  }
  if (SHELL_META.test(arg) === true) {
    return "refused shell metacharacters in mcp args";
  }
  return undefined;
}
