import fs from "node:fs";
import path from "node:path";
import { truncate_text } from "../util/json.js";
import type { ToolResult } from "./types.js";

export const DEFAULT_MAX_OUTPUT_CHARS = 20000;
export const DEFAULT_TOOL_TIMEOUT_MS = 30000;

/** True when `candidate` is `base` or a descendant (lexical). */
function is_inside(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative.startsWith("..") === false && path.isAbsolute(relative) === false;
}

/** Walk up from `target` until an existing path is found (non-recursive). */
function deepest_existing(target: string): string {
  let current = target;
  while (fs.existsSync(current) === false) {
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}

/**
 * Resolve `target` against `base_dir` and confine it inside `base_dir`.
 * After the lexical check, realpath the deepest existing ancestor and the base,
 * then re-test containment. When `for_write` is set, reject symlink leaves.
 */
export function resolve_safe_path(base_dir: string, target: string, for_write = false): string {
  const base = path.resolve(base_dir);
  const resolved = path.resolve(base, target);
  if (is_inside(base, resolved) === false) {
    throw new Error(`path_escape: ${target} escapes ${base_dir}`);
  }
  const real_base = fs.realpathSync(base);
  const existing = deepest_existing(resolved);
  const real_existing = fs.realpathSync(existing);
  const suffix = path.relative(existing, resolved);
  const real_resolved = suffix.length === 0 ? real_existing : path.resolve(real_existing, suffix);
  if (is_inside(real_base, real_resolved) === false) {
    throw new Error(`path_escape: ${target} escapes ${base_dir}`);
  }
  if (for_write === true) {
    reject_symlink_leaf(resolved, target, base_dir);
  }
  return real_resolved;
}

/** Writes must not follow a symlink leaf (create/overwrite only regular paths). */
function reject_symlink_leaf(resolved: string, target: string, base_dir: string): void {
  let info: fs.Stats;
  try {
    info = fs.lstatSync(resolved);
  } catch (err) {
    if (is_enoent(err) === true) {
      return;
    }
    throw err;
  }
  if (info.isSymbolicLink() === true) {
    throw new Error(`path_escape: ${target} escapes ${base_dir}`);
  }
}

/**
 * Deny `.lich/config.json` to file tools; allow `.lich/` writes only under
 * `skills/`; deny `.env*` basenames on writes.
 */
export function assert_file_tool_access(work_dir: string, resolved: string, mode: "read" | "write"): void {
  const base = fs.realpathSync(path.resolve(work_dir));
  const rel = path.relative(base, resolved);
  const parts = rel.split(path.sep).filter((part) => part.length > 0);
  if (parts[0] === ".lich" && parts[1] === "config.json" && parts.length === 2) {
    throw new Error("forbidden_path: .lich/config.json");
  }
  if (mode === "write" && parts[0] === ".lich" && parts[1] !== "skills") {
    throw new Error("forbidden_path: .lich writes limited to skills/");
  }
  if (mode === "write") {
    const base = path.basename(resolved);
    if (base === ".env" || base.startsWith(".env.")) {
      throw new Error("forbidden_path: .env*");
    }
  }
}

/** Read a required non-empty string argument, or throw `missing_arg`. */
export function require_string_arg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing_arg: ${key}`);
  }
  return value;
}

/** Read an optional string argument, falling back when absent/empty/non-string. */
export function optional_string_arg(args: Record<string, unknown>, key: string, fallback: string): string {
  const value = args[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return fallback;
}

/** Read an optional finite number argument, falling back when absent/invalid. */
export function optional_number_arg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value) === true) {
    return value;
  }
  return fallback;
}

/** Read an optional boolean argument, falling back when absent/invalid. */
export function optional_boolean_arg(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

/** Error thrown by `with_timeout` when the deadline elapses. */
export class ToolTimeoutError extends Error {
  constructor(label: string, timeout_ms: number) {
    super(`timeout: ${label} exceeded ${timeout_ms}ms`);
    this.name = "ToolTimeoutError";
  }
}

/**
 * Race `promise_factory` against a deadline. The abort signal passed to the
 * factory fires (first) when the deadline elapses; the timer is always
 * cleared afterwards so no handle leaks.
 */
export function with_timeout<T>(
  promise_factory: (signal: AbortSignal) => Promise<T>,
  timeout_ms: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  const holder: { timer?: ReturnType<typeof setTimeout> } = {};
  const timeout_promise = new Promise<never>((_resolve, reject) => {
    holder.timer = setTimeout(() => {
      controller.abort();
      reject(new ToolTimeoutError(label, timeout_ms));
    }, timeout_ms);
  });
  const raced = promise_factory(controller.signal);
  raced.catch(() => undefined);
  return Promise.race([raced, timeout_promise]).finally(() => {
    const timer = holder.timer;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

/** Clamp tool output to `max_chars` (delegates to util truncate_text). */
export function clamp_output(text: string, max_chars: number = DEFAULT_MAX_OUTPUT_CHARS): string {
  return truncate_text(text, max_chars);
}

/** Detect Node fs ENOENT errors without depending on error subclass shape. */
export function is_enoent(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  return code === "ENOENT";
}

/** Convert any thrown value into a failed ToolResult carrying its message. */
export function error_result(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, output: "", error: message };
}

/** Run a tool body, converting thrown errors into failed ToolResults. */
export async function capture_errors(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    return error_result(err);
  }
}