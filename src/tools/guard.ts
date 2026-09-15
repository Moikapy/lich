import path from "node:path";
import { truncate_text } from "../util/json.js";
import type { ToolResult } from "./types.js";

export const DEFAULT_MAX_OUTPUT_CHARS = 20000;
export const DEFAULT_TOOL_TIMEOUT_MS = 30000;

/**
 * Resolve `target` against `base_dir` and confine it inside `base_dir`.
 * Absolute targets are respected but must still land inside the base.
 * Throws `path_escape` on any attempt to leave the base directory.
 */
export function resolve_safe_path(base_dir: string, target: string): string {
  const base = path.resolve(base_dir);
  const resolved = path.resolve(base, target);
  const relative = path.relative(base, resolved);
  if (relative.startsWith("..") === true || path.isAbsolute(relative) === true) {
    throw new Error(`path_escape: ${target} escapes ${base_dir}`);
  }
  return resolved;
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