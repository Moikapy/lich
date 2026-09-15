import type { JsonSchemaObject } from "../../util/json_schema.js";
import { capture_errors, require_string_arg } from "../guard.js";
import type { Tool, ToolResult } from "../types.js";
import { clamp_int_arg, compose_abort_signal, USER_AGENT } from "./fetch_url.js";

const DEFAULT_MAX_RESULTS = 8;
const MAX_RESULTS = 20;
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_TIMEOUT_MS = 60000;
const SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/?q=";
const REDIRECT_PREFIXES = ["//duckduckgo.com/l/?", "/l/?"];
const RESULT_PATTERN = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

const ENTITY_REPLACEMENTS: Array<[string, string]> = [
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", "\""],
  ["&#x27;", "'"],
  ["&#39;", "'"],
];

const parameters: JsonSchemaObject = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query text" },
    max_results: { type: "number", description: "Maximum results to return (default 8, max 20)" },
    timeout_ms: { type: "number", description: "Abort the search after this many ms (default 20000, max 60000)" },
  },
  required: ["query"],
  additionalProperties: false,
};

/** Decode the handful of HTML entities DuckDuckGo uses in titles and links. */
function decode_entities(text: string): string {
  let decoded = text;
  for (const [entity, replacement] of ENTITY_REPLACEMENTS) {
    decoded = decoded.split(entity).join(replacement);
  }
  return decoded;
}

function strip_tags(raw_title: string): string {
  return decode_entities(raw_title).replace(/<[^>]*>/g, "").trim();
}

/** Resolve //duckduckgo.com/l/?uddg=<encoded> redirect links to the real target. */
function unwrap_redirect(href: string): string {
  for (const prefix of REDIRECT_PREFIXES) {
    if (href.startsWith(prefix) === false) {
      continue;
    }
    const query = href.slice(prefix.length);
    const marker_index = query.indexOf("uddg=");
    if (marker_index < 0) {
      return href;
    }
    const encoded = query.slice(marker_index + 5).split("&")[0] ?? "";
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  return href;
}

interface SearchHit {
  title: string;
  url: string;
}

function parse_results(html: string, cap: number): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const match of html.matchAll(RESULT_PATTERN)) {
    const href = match[1];
    const raw_title = match[2];
    if (href === undefined || raw_title === undefined) {
      continue;
    }
    hits.push({ title: strip_tags(raw_title), url: unwrap_redirect(decode_entities(href)) });
    if (hits.length >= cap) {
      break;
    }
  }
  return hits;
}

function format_results(hits: SearchHit[]): string {
  const lines: string[] = [];
  for (let index = 0; index < hits.length; index += 1) {
    const hit = hits[index];
    if (hit !== undefined) {
      lines.push(`${index + 1}. ${hit.title}`, `   ${hit.url}`);
    }
  }
  return lines.join("\n");
}

async function run_search(args: Record<string, unknown>, external?: AbortSignal): Promise<ToolResult> {
  const query = require_string_arg(args, "query");
  const max_results = clamp_int_arg(args, "max_results", DEFAULT_MAX_RESULTS, MAX_RESULTS);
  const timeout_ms = clamp_int_arg(args, "timeout_ms", DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  try {
    const response = await fetch(`${SEARCH_ENDPOINT}${encodeURIComponent(query)}`, {
      headers: { "user-agent": USER_AGENT, "accept-language": "en" },
      signal: compose_abort_signal(timeout_ms, external),
    });
    if (response.ok === false) {
      return { ok: false, output: "", error: `search_failed: http_${response.status}` };
    }
    const hits = parse_results(await response.text(), max_results);
    return { ok: true, output: hits.length === 0 ? "no results" : format_results(hits) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, output: "", error: `search_failed: ${message}` };
  }
}

export const web_search_tool: Tool = {
  name: "web_search",
  description: "Search the web via DuckDuckGo's HTML endpoint (no api key) and return numbered title/url results.",
  parameters,
  execute: async (args, context) => capture_errors(async () => run_search(args, context.signal)),
};