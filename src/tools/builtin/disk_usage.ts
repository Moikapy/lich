import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { JsonSchemaObject } from "../../util/json_schema.js";
import { capture_errors, optional_number_arg, optional_string_arg, resolve_safe_path } from "../guard.js";
import type { Tool, ToolContext } from "../types.js";
import { clamp_int_arg } from "./fetch_url.js";

const DEFAULT_MAX_ENTRIES = 25;
const MAX_MAX_ENTRIES = 200;
const DU_TIMEOUT_MS = 10000;

const parameters: JsonSchemaObject = {
  type: "object",
  properties: {
    path: { type: "string", description: "Directory to measure, relative to the working directory (default .)" },
    max_entries: { type: "number", description: "Show at most this many entries (default 25, max 200)" },
  },
  additionalProperties: false,
};

interface DirEntry {
  name: string;
  bytes: number;
}

function run_du(entry_path: string): Promise<number> {
  return new Promise((resolve) => {
    execFile("du", ["-sb", entry_path], { timeout: DU_TIMEOUT_MS }, (err, stdout) => {
      if (err !== null) {
        resolve(-1);
        return;
      }
      const parsed = Number.parseInt(stdout.trim().split("\t")[0] ?? "", 10);
      resolve(Number.isFinite(parsed) === true ? parsed : -1);
    });
  });
}

/** Measure every depth-1 entry iteratively; null signals du itself is missing. */
async function measure_entries(root: string): Promise<DirEntry[] | null> {
  const entries = await readdir(root, { withFileTypes: true });
  const measured: DirEntry[] = [];
  for (const entry of entries as Dirent[]) {
    const bytes = await run_du(path.join(root, entry.name));
    if (bytes < 0) {
      return null;
    }
    measured.push({ name: entry.name, bytes });
  }
  return measured;
}

function format_usage(usage: DirEntry[], max_entries: number): string {
  const sorted = [...usage].sort((a, b) => b.bytes - a.bytes);
  const total = sorted.reduce((sum, entry) => sum + entry.bytes, 0);
  const shown = sorted.slice(0, max_entries);
  const lines = shown.map((entry) => `${entry.bytes}\t${entry.name}`);
  if (sorted.length > shown.length) {
    lines.push(`(... ${sorted.length - shown.length} more entries suppressed)`);
  }
  lines.push(`TOTAL\t${total}`);
  return lines.join("\n");
}

async function run_disk_usage(args: Record<string, unknown>, work_dir: string): Promise<string> {
  const target = optional_string_arg(args, "path", ".");
  const max_entries = clamp_int_arg(args, "max_entries", DEFAULT_MAX_ENTRIES, MAX_MAX_ENTRIES);
  const root = resolve_safe_path(work_dir, target);
  const usage = await measure_entries(root);
  if (usage === null) {
    throw new Error("du_unavailable");
  }
  return format_usage(usage, max_entries);
}

export const disk_usage_tool: Tool = {
  name: "disk_usage",
  description: "Measure depth-1 directory/file sizes with du -sb and report sorted sizes plus a total.",
  parameters,
  execute: async (args, context: ToolContext) =>
    capture_errors(async () => ({ ok: true, output: await run_disk_usage(args, context.work_dir) })),
};