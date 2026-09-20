import type { JsonSchemaObject } from "../../util/json_schema.js";
import { capture_errors, optional_boolean_arg } from "../guard.js";
import type { Tool } from "../types.js";

const MAX_KEYS = 50;
const MAX_VALUE_CHARS = 2000;
/** Name pattern treated as secret by env_get and terminal env scrubbing. */
export const SECRET_PATTERN = /(secret|token|password|key|credential|auth)/i;

const parameters: JsonSchemaObject = {
  type: "object",
  properties: {
    keys: { type: "array", description: "Up to 50 variable names to inspect", items: { type: "string" } },
    prefix: { type: "string", description: "Match variable names starting with this prefix" },
    reveal: { type: "boolean", description: "Show values for non-secret keys (default false)" },
  },
  additionalProperties: false,
};

function read_keys(args: Record<string, unknown>): string[] {
  const raw = args.keys;
  if (Array.isArray(raw) === false) {
    return [];
  }
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.length > 0 && names.length < MAX_KEYS) {
      names.push(item);
    }
  }
  return names;
}

/** KEY=value for harmless names, KEY=<redacted: N chars> for secret-ish ones. */
function reveal_line(name: string): string {
  const value = process.env[name] ?? "";
  if (SECRET_PATTERN.test(name) === true) {
    return `${name}=<redacted: ${value.length} chars>`;
  }
  return `${name}=${value.slice(0, MAX_VALUE_CHARS)}`;
}

/** Non-reveal summary: KEY=set (N chars), or KEY=<unset> when absent. */
function summary_line(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    return `${name}=<unset>`;
  }
  return `${name}=set (${value.length} chars)`;
}

function prefix_names(prefix: string): string[] {
  const names: string[] = [];
  for (const name of Object.keys(process.env)) {
    if (name.startsWith(prefix) === true) {
      names.push(name);
    }
  }
  return names.sort();
}

function list_all_names(): string {
  const names = Object.keys(process.env).sort();
  return `${names.length} variables: ${names.join(", ")}`;
}

function run_env_get(args: Record<string, unknown>): string {
  const reveal = optional_boolean_arg(args, "reveal", false);
  const prefix = typeof args.prefix === "string" ? args.prefix : "";
  const keys = read_keys(args);
  if (keys.length === 0 && prefix.length === 0) {
    return list_all_names();
  }
  const names = keys.length > 0 ? keys : prefix_names(prefix);
  const lines = names.map((name) => (reveal === true ? reveal_line(name) : summary_line(name)));
  return lines.join("\n");
}

export const env_get_tool: Tool = {
  name: "env_get",
  description: "Inspect environment variables: names by default, lengths unless reveal=true (secrets always masked).",
  parameters,
  execute: async (args) => capture_errors(async () => ({ ok: true, output: run_env_get(args) })),
};