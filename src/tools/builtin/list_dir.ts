import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { JsonSchemaObject } from "../../util/json_schema.js";
import { capture_errors, optional_number_arg, optional_string_arg, resolve_safe_path } from "../guard.js";
import type { Tool } from "../types.js";

const MAX_ENTRIES = 500;
const MAX_DEPTH = 4;
const SKIP_ENTRIES = new Set(["node_modules", ".git", "dist", ".lich", ".cursor"]);

const parameters: JsonSchemaObject = {
  type: "object",
  properties: {
    path: { type: "string", description: "Directory to list, relative to the working directory (default .)" },
    depth: { type: "number", description: "How many levels deep to list (1-4, default 1)" },
  },
  additionalProperties: false,
};

async function entry_size(file_path: string): Promise<number> {
  try {
    const info = await stat(file_path);
    return info.size;
  } catch {
    return 0;
  }
}

async function safe_readdir(dir: string): Promise<Dirent[] | undefined> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
}

function sort_entries(entries: Dirent[]): Dirent[] {
  return entries
    .filter((entry) => SKIP_ENTRIES.has(entry.name) === false)
    .sort((a, b) => {
      const a_rank = a.isDirectory() === true ? 0 : 1;
      const b_rank = b.isDirectory() === true ? 0 : 1;
      if (a_rank !== b_rank) {
        return a_rank - b_rank;
      }
      return a.name.localeCompare(b.name);
    });
}

async function push_entries(
  lines: string[],
  queue: Array<{ dir: string; remaining: number }>,
  entries: Dirent[],
  current: { dir: string; remaining: number },
): Promise<boolean> {
  for (const entry of sort_entries(entries)) {
    if (lines.length >= MAX_ENTRIES) {
      return true;
    }
    const full = path.join(current.dir, entry.name);
    if (entry.isDirectory() === true) {
      lines.push(`d ${entry.name}/`);
      if (current.remaining > 1) {
        queue.push({ dir: full, remaining: current.remaining - 1 });
      }
    } else {
      lines.push(`- ${entry.name} (${await entry_size(full)} bytes)`);
    }
  }
  return false;
}

async function collect_lines(root: string, max_depth: number): Promise<string[]> {
  const lines: string[] = [];
  const queue: Array<{ dir: string; remaining: number }> = [{ dir: root, remaining: max_depth }];
  let truncated = false;
  while (queue.length > 0 && truncated === false) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    const entries = await safe_readdir(current.dir);
    if (entries === undefined) {
      continue;
    }
    truncated = await push_entries(lines, queue, entries, current);
  }
  if (truncated === true) {
    lines.push(`(... truncated at ${MAX_ENTRIES} entries)`);
  }
  return lines;
}

function clamp_depth(depth: number): number {
  return Math.min(MAX_DEPTH, Math.max(1, Math.floor(depth)));
}

export const list_dir_tool: Tool = {
  name: "list_dir",
  description: "List a directory tree iteratively (dirs first, sizes for files), skipping node_modules/.git/dist.",
  parameters,
  execute: async (args, context) =>
    capture_errors(async () => {
      const target = optional_string_arg(args, "path", ".");
      const depth = clamp_depth(optional_number_arg(args, "depth", 1));
      const root = resolve_safe_path(context.work_dir, target);
      const lines = await collect_lines(root, depth);
      return { ok: true, output: lines.join("\n") };
    }),
};