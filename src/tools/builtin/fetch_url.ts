import type { JsonSchemaObject } from "../../util/json_schema.js";
import { capture_errors, clamp_output, optional_number_arg, require_string_arg } from "../guard.js";
import type { Tool, ToolResult } from "../types.js";

const DEFAULT_MAX_CHARS = 20000;
const MAX_MAX_CHARS = 100000;
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_TIMEOUT_MS = 60000;

export const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";

const parameters: JsonSchemaObject = {
  type: "object",
  properties: {
    url: { type: "string", description: "Absolute http:// or https:// URL to GET" },
    max_chars: { type: "number", description: "Clamp the body to this many chars (default 20000, max 100000)" },
    timeout_ms: { type: "number", description: "Abort the request after this many ms (default 20000, max 60000)" },
  },
  required: ["url"],
  additionalProperties: false,
};

/** Clamp a count-like numeric argument into the inclusive range [1, max]. */
export function clamp_int_arg(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  return Math.min(max, Math.max(1, Math.floor(optional_number_arg(args, key, fallback))));
}

/** Reject malformed and non-http(s) URLs (file:, ftp:, data:, ...) with invalid_url. */
export function valid_http_url(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid_url: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`invalid_url: unsupported protocol ${parsed.protocol}`);
  }
}

/** Compose the per-call timeout signal with the executor's cancellation signal. */
export function compose_abort_signal(timeout_ms: number, external?: AbortSignal): AbortSignal {
  const timeout_signal = AbortSignal.timeout(timeout_ms);
  return external === undefined ? timeout_signal : AbortSignal.any([timeout_signal, external]);
}

async function run_fetch_url(args: Record<string, unknown>, external?: AbortSignal): Promise<ToolResult> {
  const url = require_string_arg(args, "url");
  valid_http_url(url);
  const max_chars = clamp_int_arg(args, "max_chars", DEFAULT_MAX_CHARS, MAX_MAX_CHARS);
  const timeout_ms = clamp_int_arg(args, "timeout_ms", DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": USER_AGENT },
    signal: compose_abort_signal(timeout_ms, external),
  });
  const content_type = response.headers.get("content-type") ?? "";
  if (response.ok === false) {
    return { ok: false, output: "", error: `http_${response.status}` };
  }
  if (content_type.startsWith("image/") === true || content_type.startsWith("application/octet-stream") === true) {
    return { ok: false, output: "", error: `unsupported_content_type: ${content_type}` };
  }
  const text = await response.text();
  const marker = content_type.toLowerCase().includes("text/html") === true ? "[html content]\n" : "";
  const body = clamp_output(`${marker}${text}`, max_chars);
  return { ok: true, output: `${header_line(response, text)}\n${body}` };
}

function header_line(response: Response, text: string): string {
  const content_type = response.headers.get("content-type") ?? "unknown";
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  const bytes = Number.isFinite(declared) === true ? declared : Buffer.byteLength(text, "utf8");
  return `# ${response.status} ${content_type} (${bytes} bytes)`;
}

export const fetch_url_tool: Tool = {
  name: "fetch_url",
  description: "GET an http(s) URL and return the response body text with a status header; rejects binary content.",
  parameters,
  execute: async (args, context) => capture_errors(async () => run_fetch_url(args, context.signal)),
};