import { safe_json_parse, truncate_text } from "../util/json.js";
import { ProviderError } from "./types.js";
import type { ChatOptions, ProviderErrorKind } from "./types.js";

/**
 * HTTP/error helpers shared by the hand-written provider clients
 * (openai, anthropic, ollama).
 */
export const MAX_ERROR_BODY_CHARS = 500;
export const OVERFLOW_BODY_PATTERN =
  /context.?length|maximum context|prompt(?: is)? too (?:long|large)|token.?limit|context window|too many tokens|exceed.{0,30}context limit/i;

export function first_non_empty(values: ReadonlyArray<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export function build_bearer_headers(api_key: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (api_key !== undefined) {
    headers.authorization = `Bearer ${api_key}`;
  }
  return headers;
}

export function build_abort_signal(options: ChatOptions | undefined, timeout_ms: number | undefined): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (timeout_ms !== undefined && timeout_ms > 0) {
    signals.push(AbortSignal.timeout(timeout_ms));
  }
  if (options?.signal !== undefined) {
    signals.push(options.signal);
  }
  const [only_signal] = signals;
  if (only_signal !== undefined && signals.length === 1) {
    return only_signal;
  }
  return AbortSignal.any(signals);
}

export function build_request_init(
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal | undefined,
): RequestInit {
  return {
    method: "POST",
    headers,
    body,
    ...(signal !== undefined ? { signal } : {}),
  };
}

export async function do_fetch(fetch_fn: typeof fetch, url: string, init: RequestInit, provider_name: string): Promise<Response> {
  try {
    return await fetch_fn(url, init);
  } catch (error) {
    const label = is_abort_like(error) === true ? "request aborted or timed out" : "fetch failed";
    throw new ProviderError({
      kind: "network",
      provider_name,
      message: `${label}: ${describe_error(error)}`,
      cause: error,
    });
  }
}

async function read_response_text(response: Response, provider_name: string): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw new ProviderError({
      kind: "network",
      provider_name,
      message: `failed to read response body: ${describe_error(error)}`,
      cause: error,
    });
  }
}

export async function read_success_json<T>(response: Response, provider_name: string): Promise<T> {
  const text = await read_response_text(response, provider_name);
  const dto = safe_json_parse<T>(text);
  if (dto === undefined) {
    throw new ProviderError({
      kind: "bad_request",
      provider_name,
      message: `unparseable success response: ${truncate_text(text, MAX_ERROR_BODY_CHARS)}`,
    });
  }
  return dto;
}

function parse_retry_after_ms(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (raw === null) {
    return undefined;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) === false || seconds < 0) {
    return undefined;
  }
  return Math.round(seconds * 1000);
}

/** 5xx (including Anthropic's 529 overloaded) maps to rate_limit so it is retried. */
function status_to_error_kind(status: number, body_text: string, overflow_pattern: RegExp): ProviderErrorKind {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 429 || status >= 500) {
    return "rate_limit";
  }
  if (status === 413 || (status === 400 && overflow_pattern.test(body_text) === true)) {
    return "overflow";
  }
  return "bad_request";
}

export async function to_http_error(
  response: Response,
  provider_name: string,
  overflow_pattern: RegExp = OVERFLOW_BODY_PATTERN,
): Promise<ProviderError> {
  const body_text = truncate_text(await read_response_text(response, provider_name), MAX_ERROR_BODY_CHARS);
  const retry_after_ms = parse_retry_after_ms(response);
  return new ProviderError({
    kind: status_to_error_kind(response.status, body_text, overflow_pattern),
    provider_name,
    message: `${provider_name} http ${response.status}: ${body_text}`,
    status: response.status,
    ...(retry_after_ms !== undefined ? { retry_after_ms } : {}),
  });
}

export function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describe_error(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function error_name(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "name" in error) {
    const name = (error as { name?: unknown }).name;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

export function is_abort_like(error: unknown): boolean {
  const name = error_name(error);
  return name === "AbortError" || name === "TimeoutError";
}
