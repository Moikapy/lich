import { readdirSync, readFileSync } from "node:fs";
import type { JsonSchemaObject } from "../../util/json_schema.js";
import { capture_errors, clamp_output, optional_string_arg } from "../guard.js";
import type { Tool } from "../types.js";
import { clamp_int_arg } from "./fetch_url.js";

const DEFAULT_MAX_RESULTS = 50;
const MAX_MAX_RESULTS = 500;
const CMDLINE_MAX_CHARS = 200;
const PROC_DIR = "/proc";
const PID_PATTERN = /^[0-9]+$/;

const parameters: JsonSchemaObject = {
  type: "object",
  properties: {
    filter: { type: "string", description: "Case-insensitive substring match on the command line" },
    max_results: { type: "number", description: "Stop after this many processes (default 50, max 500)" },
  },
  additionalProperties: false,
};

/** Read a /proc file; empty string when the process vanished mid-scan. */
function read_proc_text(pid: string, file: string): string {
  try {
    return readFileSync(`${PROC_DIR}/${pid}/${file}`, "utf8");
  } catch {
    return "";
  }
}

function numeric_pids(): string[] {
  const pids: string[] = [];
  for (const name of readdirSync(PROC_DIR)) {
    if (PID_PATTERN.test(name) === true) {
      pids.push(name);
    }
  }
  return pids;
}

function cmdline_text(pid: string): string {
  const raw = read_proc_text(pid, "cmdline");
  const parts = raw.split("\0").filter((part) => part.length > 0);
  return parts.join(" ").slice(0, CMDLINE_MAX_CHARS);
}

function comm_text(pid: string): string {
  return read_proc_text(pid, "comm").trim();
}

function collect_lines(filter: string, max_results: number): { lines: string[]; total: number } {
  const lines: string[] = [];
  let total = 0;
  for (const pid of numeric_pids()) {
    const comm = comm_text(pid);
    const cmdline = cmdline_text(pid);
    const haystack = cmdline.length > 0 ? cmdline : comm;
    if (filter.length > 0 && haystack.toLowerCase().includes(filter) === false) {
      continue;
    }
    total += 1;
    if (lines.length < max_results) {
      lines.push(`${pid}\t${comm}\t${cmdline}`);
    }
  }
  return { lines, total };
}

function run_process_list(args: Record<string, unknown>): string {
  const filter = optional_string_arg(args, "filter", "").toLowerCase();
  const max_results = clamp_int_arg(args, "max_results", DEFAULT_MAX_RESULTS, MAX_MAX_RESULTS);
  let listing: { lines: string[]; total: number };
  try {
    listing = collect_lines(filter, max_results);
  } catch {
    throw new Error("proc_unavailable");
  }
  const lines = [...listing.lines];
  if (listing.total > listing.lines.length) {
    lines.push(`(... ${listing.total - listing.lines.length} more processes suppressed)`);
  }
  if (lines.length === 0) {
    lines.push("no matching processes");
  }
  return clamp_output(lines.join("\n"));
}

export const process_list_tool: Tool = {
  name: "process_list",
  description: "Snapshot running processes from /proc as pid/comm/cmdline rows with an optional filter.",
  parameters,
  execute: async (args) => capture_errors(async () => ({ ok: true, output: run_process_list(args) })),
};