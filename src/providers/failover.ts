import { sleep } from "../util/sleep.js";
import { ProviderError } from "./types.js";
import type { ProviderErrorKind } from "./types.js";

const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_BACKOFF_MAX_MS = 8000;
/** Cap honored Retry-After; longer values skip retry and fail over. */
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Map any thrown value onto a provider error kind for retry/failover logic.
 */
export function classify_error(error: unknown): ProviderErrorKind {
  if (error instanceof ProviderError) {
    return error.kind;
  }
  if (is_abort_like(error) === true || is_type_error(error) === true) {
    return "network";
  }
  return "unknown";
}

/**
 * Deterministic exponential backoff: base * 2**attempt capped at max, plus a
 * fixed jitter term so simultaneous callers spread out without Math.random.
 */
export function compute_backoff_ms(
  attempt: number,
  base_ms: number = DEFAULT_BACKOFF_BASE_MS,
  max_ms: number = DEFAULT_BACKOFF_MAX_MS,
): number {
  const exponential = Math.floor(base_ms * 2 ** attempt);
  const jitter = Math.floor((base_ms * attempt) / 2);
  return Math.min(exponential + jitter, max_ms);
}

export interface RetryParams {
  max_attempts: number;
  signal?: AbortSignal;
  on_retry?: (error: ProviderErrorKind, attempt: number, delay_ms: number) => void;
}

/**
 * Run `fn` with bounded retries. Only rate_limit and network failures are
 * retried; a caller abort and all other errors rethrow immediately. A while
 * loop (never recursion) drives the attempts.
 */
export async function run_with_retries<T>(
  fn: (attempt: number) => Promise<T>,
  params: RetryParams,
): Promise<T> {
  const outcome = await execute_retry_loop(fn, params);
  if (outcome.ok === true) {
    return outcome.value;
  }
  throw outcome.error;
}

type RetryOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function execute_retry_loop<T>(
  fn: (attempt: number) => Promise<T>,
  params: RetryParams,
): Promise<RetryOutcome<T>> {
  let attempt = 1;
  while (attempt <= Math.max(params.max_attempts, 1)) {
    const outcome = await run_attempt(fn, attempt);
    if (outcome.ok === true) {
      return outcome;
    }
    if (caller_aborted(params.signal) === true) {
      return { ok: false, error: make_abort_error(outcome.error) };
    }
    const kind = classify_error(outcome.error);
    if (
      is_retryable_kind(kind) === false ||
      attempt >= params.max_attempts ||
      retry_after_too_long(outcome.error) === true
    ) {
      return outcome;
    }
    const delay_ms = delay_for_error(outcome.error, attempt);
    params.on_retry?.(kind, attempt, delay_ms);
    await wait_out_delay(delay_ms, params.signal);
    if (params.signal?.aborted === true) {
      return { ok: false, error: make_abort_error(outcome.error) };
    }
    attempt += 1;
  }
  return { ok: false, error: make_abort_error(undefined) };
}

async function run_attempt<T>(fn: (attempt: number) => Promise<T>, attempt: number): Promise<RetryOutcome<T>> {
  try {
    return { ok: true, value: await fn(attempt) };
  } catch (error) {
    return { ok: false, error };
  }
}

function is_retryable_kind(kind: ProviderErrorKind): boolean {
  return kind === "rate_limit" || kind === "network";
}

function caller_aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Honor a server-provided Retry-After as the delay floor, capped at
 * MAX_RETRY_AFTER_MS. Values above the cap are rejected earlier via
 * retry_after_too_long so the router can fail over instead of sleeping.
 */
function delay_for_error(error: unknown, attempt: number): number {
  const backoff = compute_backoff_ms(attempt);
  if (error instanceof ProviderError && error.retry_after_ms !== undefined) {
    const capped = Math.min(error.retry_after_ms, MAX_RETRY_AFTER_MS);
    return capped > backoff ? capped : backoff;
  }
  return backoff;
}

function retry_after_too_long(error: unknown): boolean {
  return (
    error instanceof ProviderError &&
    error.retry_after_ms !== undefined &&
    error.retry_after_ms > MAX_RETRY_AFTER_MS
  );
}

async function wait_out_delay(delay_ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (delay_ms <= 0) {
    return;
  }
  try {
    await sleep(delay_ms, signal);
  } catch {
    // sleep_aborted: the abort is observed right after the wait.
  }
}

function make_abort_error(cause: unknown): Error {
  const error = new Error("operation aborted before completion");
  error.name = "AbortError";
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
}

function is_type_error(error: unknown): boolean {
  return error instanceof TypeError;
}

function error_name(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "name" in error) {
    const name = (error as { name?: unknown }).name;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

function is_abort_like(error: unknown): boolean {
  const name = error_name(error);
  return name === "AbortError" || name === "TimeoutError";
}