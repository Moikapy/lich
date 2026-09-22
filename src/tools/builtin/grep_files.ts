import { readFile, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import type { JsonSchemaObject } from "../../util/json_schema.js";
import {
  assert_file_tool_access,
  capture_errors,
  optional_number_arg,
  optional_string_arg,
  require_string_arg,
  resolve_safe_path,
} from "../guard.js";
import type { Tool, ToolContext } from "../types.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".lich", ".cursor"]);
const MAX_FILE_BYTES = 1000000;
const SNIFF_BYTES = 1000;
const DEFAULT_MAX_RESULTS = 200;
const MAX_MAX_RESULTS = 2000;
const MAX_LINE_CHARS = 4000;
const SAFE_REGEX_CHARS = 22;
const REGEX_TIMEOUT_MS = 50;

const parameters: JsonSchemaObject = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Regular expression source to match against each line" },
    path: { type: "string", description: "Directory or file to search, relative to the working directory (default .)" },
    glob: { type: "string", description: "Simple filename filter like *.ts (suffix match only)" },
    max_results: { type: "number", description: "Stop after this many matches (default 200, max 2000)" },
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

/** Time-bound regex.test so nested quantifiers cannot freeze the event loop. */
function safe_regex_test(regex: RegExp, line: string): boolean {
  try {
    return vm.runInNewContext("re.test(line)", { re: regex, line }, { timeout: REGEX_TIMEOUT_MS }) === true;
  } catch {
    return false;
  }
}

/** True when the pattern has no regex metacharacters (safe for includes). */
function is_literal_pattern(pattern: string): boolean {
  return /^[A-Za-z0-9_./:@-]+$/.test(pattern) === true;
}

function line_matches(regex: RegExp, pattern: string, line: string): boolean {
  const capped = line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line;
  if (capped.length <= SAFE_REGEX_CHARS) {
    return safe_regex_test(regex, capped);
  }
  if (is_literal_pattern(pattern) === true) {
    return capped.includes(pattern);
  }
  // Complex regex on a long line: only probe a short prefix (ReDoS bound).
  return safe_regex_test(regex, capped.slice(0, SAFE_REGEX_CHARS));
}

function match_lines(
  lines: string[],
  regex: RegExp,
  pattern: string,
): Array<{ line_no: number; text: string }> {
  const hits: Array<{ line_no: number; text: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    const capped = line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line;
    if (line_matches(regex, pattern, capped) === true) {
      hits.push({ line_no: index + 1, text: capped.trim() });
    }
  }
  return hits;
}

async function safe_readdir(dir: string): Promise<Dirent[] | undefined> {
  try {
    return await readdir(dir, { withFileTypes: true });
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
    if (SKIP_DIRS.has(entry.name) === true || entry.isSymbolicLink() === true) {
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

/** Re-check confinement and deny lists before reading a candidate path. */
function guard_grep_target(work_dir: string, absolute: string): string {
  const relative = path.relative(work_dir, absolute);
  const safe = resolve_safe_path(work_dir, relative);
  assert_file_tool_access(work_dir, safe, "read");
  return safe;
}

function throw_if_aborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new Error("cancelled");
  }
}

async function search_file(
  frame: StackFrame,
  work_dir: string,
  relative_root: string,
  regex: RegExp,
  collected: string[],
  max_results: number,
  signal?: AbortSignal,
): Promise<boolean> {
  throw_if_aborted(signal);
  let safe: string;
  try {
    safe = guard_grep_target(work_dir, frame.dir);
  } catch {
    return false;
  }
  const size = await file_size(safe);
  const lines = await read_if_text(safe, size);
  if (lines === undefined) {
    return false;
  }
  const relative = path.relative(relative_root, safe);
  for (const hit of match_lines(lines, regex)) {
    collected.push(`${relative}:${hit.line_no}: ${hit.text}`);
    if (collected.length >= max_results) {
      return true;
    }
  }
  return false;
}

async function search_tree(
  root: string,
  work_dir: string,
  regex: RegExp,
  matcher: (name: string) => boolean,
  max_results: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const collected: string[] = [];
  const stack: StackFrame[] = [{ dir: root, name: root }];
  while (stack.length > 0 && collected.length < max_results) {
    throw_if_aborted(signal);
    const frame = stack.pop();
    if (frame === undefined) {
      break;
    }
    const found = await scan_dir(frame, matcher);
    for (const file of found.files) {
      const hit_cap = await search_file(file, work_dir, root, regex, collected, max_results, signal);
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
  work_dir: string,
  regex: RegExp,
  collected: string[],
  max_results: number,
  signal?: AbortSignal,
): Promise<boolean> {
  return search_file(
    { dir: file_path, name: path.basename(file_path) },
    work_dir,
    path.dirname(file_path),
    regex,
    collected,
    max_results,
    signal,
  );
}

async function collect_file_matches(
  root: string,
  work_dir: string,
  regex: RegExp,
  matcher: (name: string) => boolean,
  max_results: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const collected: string[] = [];
  if (matcher(path.basename(root)) === true) {
    await search_file_direct(root, work_dir, regex, collected, max_results, signal);
  }
  return collected;
}

function clamp_max_results(raw: number): number {
  return Math.min(MAX_MAX_RESULTS, Math.max(1, Math.floor(raw)));
}

async function run_grep(args: Record<string, unknown>, work_dir: string, signal?: AbortSignal): Promise<string> {
  const pattern = require_string_arg(args, "pattern");
  const target = optional_string_arg(args, "path", ".");
  const max_results = clamp_max_results(optional_number_arg(args, "max_results", DEFAULT_MAX_RESULTS));
  const glob = optional_string_arg(args, "glob", "");
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    throw new Error(`invalid_regex: ${pattern}`);
  }
  const matcher = glob.length > 0 ? glob_matcher(glob) : () => true;
  const root = resolve_safe_path(work_dir, target);
  assert_file_tool_access(work_dir, root, "read");
  const root_stat = await stat(root);
  const cap = max_results + 1;
  const matches =
    root_stat.isDirectory() === true
      ? await search_tree(root, work_dir, regex, matcher, cap, signal)
      : await collect_file_matches(root, work_dir, regex, matcher, cap, signal);
  return finalize_output(matches, max_results);
}

export const grep_files_tool: Tool = {
  name: "grep_files",
  description: "Search files line-by-line with a regex, skipping node_modules/.git/dist and binary files.",
  parameters,
  execute: async (args, context: ToolContext) =>
    capture_errors(async () => {
      const output = await run_grep(args, context.work_dir, context.signal);
      return { ok: true, output };
    }),
};
