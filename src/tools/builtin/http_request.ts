import type { JsonSchemaObject } from "../../util/json_schema.js";
import { capture_errors, clamp_output, optional_string_arg, require_string_arg } from "../guard.js";
import type { Tool, ToolResult } from "../types.js";
import { safe_fetch } from "../url_guard.js";
import { clamp_int_arg, compose_abort_signal, valid_http_url } from "./fetch_url.js";

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;
const DEFAULT_MAX_CHARS = 20000;
const MAX_MAX_CHARS = 100000;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const REPORTED_HEADERS = ["content-length", "ratelimit-remaining", "retry-after"];

const parameters: JsonSchemaObject = {
  type: "object",
  properties: {
    url: { type: "string", description: "Absolute http:// or https:// URL to call" },
    method: { type: "string", description: "HTTP method: GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS (default GET)" },
    headers: { type: "object", description: "Request headers as name/value pairs (values stringified)" },
    body: { type: "string", description: "Request body text (ignored for GET/HEAD)" },
    timeout_ms: { type: "number", description: "Abort the request after this many ms (default 30000, max 120000)" },
    max_chars: { type: "number", description: "Clamp the body to this many chars (default 20000, max 100000)" },
  },
  required: ["url"],
  additionalProperties: false,
};

function read_method(args: Record<string, unknown>): string {
  const method = optional_string_arg(args, "method", "GET").toUpperCase();
  if (METHODS.has(method) === false) {
    throw new Error(`invalid_method: ${method}`);
  }
  return method;
}

/** Flatten caller headers to strings, skipping null/undefined values. */
function read_headers(args: Record<string, unknown>): Record<string, string> {
  const raw = args.headers;
  const headers: Record<string, string> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) === true) {
    return headers;
  }
  for (const [name, value] of Object.entries(raw)) {
    if (value !== undefined && value !== null) {
      headers[name] = String(value);
    }
  }
  return headers;
}

function header_lines(response: Response): string[] {
  const lines: string[] = [];
  for (const name of REPORTED_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) {
      lines.push(`# header ${name}: ${value}`);
    }
  }
  return lines;
}

async function run_http(args: Record<string, unknown>, external?: AbortSignal): Promise<ToolResult> {
  const url = require_string_arg(args, "url");
  valid_http_url(url);
  const method = read_method(args);
  const timeout_ms = clamp_int_arg(args, "timeout_ms", DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const max_chars = clamp_int_arg(args, "max_chars", DEFAULT_MAX_CHARS, MAX_MAX_CHARS);
  const init: RequestInit = {
    method,
    headers: read_headers(args),
    signal: compose_abort_signal(timeout_ms, external),
  };
  if (method !== "GET" && method !== "HEAD") {
    const body = optional_string_arg(args, "body", "");
    if (body.length > 0) {
      init.body = body;
    }
  }
  const response = await safe_fetch(url, init);
  const content_type = response.headers.get("content-type") ?? "unknown";
  const text = await response.text();
  const sections = [
    `# status ${response.status}`,
    `# content-type ${content_type}`,
    ...header_lines(response),
    "",
    clamp_output(text, max_chars),
  ];
  return { ok: true, output: sections.join("\n") };
}

export const http_request_tool: Tool = {
  name: "http_request",
  description: "Call an http(s) API with a custom method/headers/body and return status, key headers, and the body.",
  parameters,
  execute: async (args, context) => capture_errors(async () => run_http(args, context.signal)),
};
