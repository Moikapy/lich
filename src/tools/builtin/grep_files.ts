import { readFile, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { JsonSchemaObject } from "../../util/json_schema.js";
import { capture_errors, optional_number_arg, optional_string_arg, require_string_arg, resolve_safe_path } from "../guard.js";
import type { Tool, ToolContext } from "../types.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".lich", ".cursor"]);
const MAX_FILE_BYTES = 1000000;
const SNIFF_BYTES = 1000;
const DEFAULT_MAX_RESULTS = 200;

const parameters: JsonSchemaObject = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Regular expression source to match against each line" },
    path: { type: "string", description: "Directory or file to search, relative to the working directory (default .)" },
    glob: { type: "string", description: "Simple filename filter like *.ts (suffix match only)" },
    max_results: { type: "number", description: "Stop after this many matches (default 200)" },
  },
  required: ["pattern"],
  additionalProperties: false,
};

/** Translate a simple `*.ts` / `prefix.*` glob into a suffix/prefix predicate. */
function glob_matcher(glob: string): (name: string) => boolean {
  const star = glob.indexOf("*");
  if (star < 0) {
    return (name) => name === glob;
  }
  const prefix = glob.slice(0, star);
  const suffix = glob.slice(star + 1);
  return (name) => name.startsWith(prefix) === true && name.endsWith(suffix) === true;
}

function is_binary(buffer: Buffer): boolean {
  const limit = Math.min(SNIFF_BYTES, buffer.length);
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

async function read_if_text(file_path: string, size: number): Promise<string[] | undefined> {
  if (size >= MAX_FILE_BYTES) {
    return undefined;
  }
  try {
    const content = await readFile(file_path);
    if (is_binary(content) === true) {
      return undefined;
    }
    return content.toString("utf8").split("\n");
  } catch {
    return undefined;
  }
}

function match_lines(lines: string[], regex: RegExp): Array<{ line_no: number; text: string }> {
  const hits: Array<{ line_no: number; text: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && regex.test(line) === true) {
      hits.push({ line_no: index + 1, text: line.trim() });
    }
  }
  return hits;
}

async function safe_readdir(dir: string): Promise<Dirent[] | undefined> {
  try {
    return await readdir(dir, { withFileTypes: true });
  abort_marker: void 0;
  } catch {
    return undefined;
  }
}

async function file_size(file_path: string): Promise<number> {
  try {
    const info = await stat(file_path);
    return info.size;
  } catch {
    return 0;
  }
}

interface StackFrame {
  dir: string;
  name: string;
}

async function scan_dir(
  frame: StackFrame,
  matcher: (name: string) => boolean,
): Promise<{ files: StackFrame[]; dirs: StackFrame[] }> {
  const files: StackFrame[] = [];
  const dirs: StackFrame[] = [];
  const entries = await safe_readdir(frame.dir);
  if (entries === undefined) {
    return { files, dirs };
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name) === true) {
      continue;
    }
    const full = path.join(frame.dir, entry.name);
    if (entry.isDirectory() === true) {
      dirs.push({ dir: full, name: entry.name });
    } else if (matcher(entry.name) === true) {
      files.push({ dir: full, name: entry.name });
    }
  }
  return { files, dirs };
}

async function search_file(
  frame: StackFrame,
  relative_root: string,
  regex: RegExp,
  collected: string[],
  max_results: number,
): Promise<boolean> {
  const size = await file_size(frame.dir);
  const lines = await read_if_text(frame.dir, size);
  if (lines === undefined) {
    return false;
  }
  const relative = path.relative(relative_root, frame.dir);
  for (const hit of match_lines(lines, regex)) {
    collected.push(`${relative}:${hit.line_no}: ${hit.text}`);
    if (collected.length >= max_results) {
      return true;
    }
  }
  return false;
}

async function search_tree(root: string, regex: RegExp, matcher: (name: string) => boolean, max_results: number): Promise<string[]> {
  const collected: string[] = [];
  const stack: StackFrame[] = [{ dir: root, name: root }];
  while (stack.length > 0 && collected.length < max_results) {
    const frame = stack.pop();
    if (frame === undefined) {
      break;
    }
    const found = await scan_dir(frame, matcher);
    for (const file of found.files) {
      const hit_cap = await search_file(file, root, regex, collected, max_results);
      if (hit_cap === true) {
        break;
      }
    }
    for (const dir of found.dirs) {
      stack.push(dir);
    }
  }
  return collected;
}

function finalize_output(matches: string[], max_results: number): string {
  if (matches.length > max_results) {
    const shown = matches.slice(0, max_results);
    const suppressed = matches.length - max_results;
    return shown.join("\n") + `\n(... ${suppressed} more matches suppressed)`;
  }
  return matches.join("\n");
}

function search_file_direct(
  file_path: string,
  regex: RegExp,
  collected: string[],
  max_results: number,
): Promise<boolean> {
  return search_file({ dir: file_path, name: path.basename(file_path) }, path.dirname(file_path), regex, collected, max_results);
}

async function collect_file_matches(root: string, regex: RegExp, matcher: (name: string) => boolean, max_results: number): Promise<string[]> {
  const collected: string[] = [];
  if (matcher(path.basename(root)) === true) {
    await search_file_direct(root, regex, collected, max_results);
  }
  return collected;
}

async function run_grep(args: Record<string, unknown>, work_dir: string): Promise<string> {
  const pattern = require_string_arg(args, "pattern");
  const target = optional_string_arg(args, "path", ".");
  const max_results = Math.max(1, Math.floor(optional_number_arg(args, "max_results", DEFAULT_MAX_RESULTS)));
  const glob = optional_string_arg(args, "glob", "");
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    throw new Error(`invalid_regex: ${pattern}`);
  }
  const matcher = glob.length > 0 ? glob_matcher(glob) : () => true;
  const root = resolve_safe_path(work_dir, target);
  const root_stat = await stat(root);
  const cap = max_results + 1;
  const matches = root_stat.isDirectory() === true
    ? await search_tree(root, regex, matcher, cap)
    : await collect_file_matches(root, regex, matcher, cap);
  return finalize_output(matches, max_results);
}

export const grep_files_tool: Tool = {
  name: "grep_files",
  description: "Search files line-by-line with a regex, skipping node_modules/.git/dist and binary files.",
  parameters,
  execute: async (args, context: ToolContext) =>
    capture_errors(async () => {
      const output = await run_grep(args, context.work_dir);
      return { ok: true, output };
    }),
};