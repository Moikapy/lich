import { readdirSync, readFileSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { JsonSchemaObject } from "../../util/json_schema.js";
import {
  capture_errors,
  clamp_output,
  is_enoent,
  optional_number_arg,
  require_string_arg,
  resolve_safe_path,
} from "../guard.js";
import type { Tool, ToolContext } from "../types.js";

export const MAX_DOC_OUTPUT_CHARS = 30000;
const DEFAULT_DOC_LIMIT = 400;
export const DOCS_UNAVAILABLE = "docs_unavailable: set LICH_DOCS_DIR or install the lich package with docs";
const MAX_AVAILABLE_LISTED = 8;
const MAX_WALK_DEPTH = 4;
const PACKAGE_DOCS_CANDIDATES = ["../../docs/", "../docs/"];

let cached_root: string | undefined;
let cached_files: string[] | undefined;

const parameters: JsonSchemaObject = {
  type: "object",
  properties: {
    path: { type: "string", description: "Doc path relative to the lich docs root (e.g. index.md or user-guide/cli.md)" },
    offset: { type: "number", description: "1-based line number to start reading from" },
    limit: { type: "number", description: "Maximum number of lines to return (default 400)" },
  },
  required: ["path"],
  additionalProperties: false,
};

/** Clear the memoized docs root/file list (used by tests and re-resolution). */
export function reset_docs_cache(): void {
  cached_root = undefined;
  cached_files = undefined;
}

/** Directory qualifies only when it contains a readable index.md file. */
function dir_with_index(candidate: string): string | undefined {
  try {
    if (statSync(candidate).isDirectory() === false) {
      return undefined;
    }
    if (statSync(path.join(candidate, "index.md")).isFile() === false) {
      return undefined;
    }
    return path.resolve(candidate);
  } catch {
    return undefined;
  }
}

function env_docs_root(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  const nested = dir_with_index(path.join(value, "docs"));
  if (nested !== undefined) {
    return nested;
  }
  return dir_with_index(value);
}

/** Package-relative docs: src runs resolve ../../docs, bundled dist/index.js resolves ../docs. */
function package_docs_root(): string | undefined {
  for (const candidate of PACKAGE_DOCS_CANDIDATES) {
    try {
      const found = dir_with_index(fileURLToPath(new URL(candidate, import.meta.url)));
      if (found !== undefined) {
        return found;
      }
    } catch {
      // not a file url or missing — try the next candidate
    }
  }
  return undefined;
}

/**
 * Resolve the lich docs root, memoized after the first success. Order:
 * (1) LICH_DOCS_DIR env, (2) <work_dir>/docs, (3) package-relative docs.
 */
function default_resolve_docs_root(context: ToolContext): string | undefined {
  if (cached_root !== undefined) {
    return cached_root;
  }
  const candidates: Array<string | undefined> = [
    env_docs_root(context.env["LICH_DOCS_DIR"]),
    dir_with_index(path.join(context.work_dir, "docs")),
    package_docs_root(),
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined) {
      cached_root = candidate;
      return candidate;
    }
  }
  return undefined;
}

type DocsRootResolver = (context: ToolContext) => string | undefined;

let active_resolver: DocsRootResolver = default_resolve_docs_root;

/**
 * Swap the docs-root resolver (tests use this to simulate "no docs at all",
 * which the package-relative fallback would otherwise always defeat).
 */
export function set_docs_root_resolver(override: DocsRootResolver | undefined): void {
  active_resolver = override ?? default_resolve_docs_root;
}

/** Entry point both tools and registration use; honors test-injected resolvers. */
export function resolve_docs_root(context: ToolContext): string | undefined {
  return active_resolver(context);
}

function collect_doc_entries(
  current: { dir: string; depth: number },
  root: string,
  files: string[],
  stack: Array<{ dir: string; depth: number }>,
): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(current.dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(current.dir, entry.name);
    if (entry.isDirectory() === true) {
      if (entry.name !== ".vitepress" && current.depth < MAX_WALK_DEPTH) {
        stack.push({ dir: full, depth: current.depth + 1 });
      }
      continue;
    }
    if (entry.isFile() === true && entry.name.endsWith(".md") === true) {
      files.push(path.relative(root, full));
    }
  }
}

/** Iterative (stack-based) walk of the docs tree; skips .vitepress, depth cap 4. */
function walk_doc_files(root: string): string[] {
  const files: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: path.resolve(root), depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      continue;
    }
    collect_doc_entries(current, path.resolve(root), files, stack);
  }
  files.sort();
  return files;
}

/** Sorted relative .md paths under the docs root, memoized per resolved root. */
export function list_doc_files(root: string): string[] {
  if (cached_root === root && cached_files !== undefined) {
    return cached_files;
  }
  const files = walk_doc_files(root);
  if (cached_root === root) {
    cached_files = files;
  }
  return files;
}

/** Resolve (and cache) the docs root for a tool call; throws docs_unavailable when absent. */
export function require_docs_root(context: ToolContext): string {
  const root = resolve_docs_root(context);
  if (root === undefined) {
    throw new Error(DOCS_UNAVAILABLE);
  }
  return root;
}

function not_found_error(target: string, files: string[]): string {
  const listed = files.slice(0, MAX_AVAILABLE_LISTED).join(", ");
  return `not_found: ${target} (available: ${listed.length > 0 ? listed : "none"})`;
}

/** Confine the request inside the docs root; accept the path with or without ".md". */
function resolve_doc_rel(root: string, files: string[], target: string): string | undefined {
  if (path.isAbsolute(target) === true) {
    throw new Error(`path_escape: ${target} is not relative to the docs root`);
  }
  const absolute = resolve_safe_path(root, target);
  const rel = path.relative(path.resolve(root), absolute);
  if (files.includes(rel) === true) {
    return rel;
  }
  if (rel.endsWith(".md") === false && files.includes(`${rel}.md`) === true) {
    return `${rel}.md`;
  }
  return undefined;
}

function clamp_line_arg(args: Record<string, unknown>, key: string, fallback: number): number {
  return Math.max(1, Math.trunc(optional_number_arg(args, key, fallback)));
}

/** Loop-based line slice: 1-based offset, max `limit` lines. */
function slice_lines(content: string, offset: number, limit: number): string {
  const lines = content.split("\n");
  const start = Math.min(Math.max(0, offset - 1), lines.length);
  const end = Math.min(lines.length, start + Math.max(0, limit));
  const picked: string[] = [];
  for (let index = start; index < end; index += 1) {
    const line = lines[index];
    if (line !== undefined) {
      picked.push(line);
    }
  }
  return picked.join("\n");
}

export const docs_read_tool: Tool = {
  name: "docs_read",
  description: "Read one bundled lich doc file, optionally sliced by 1-based line offset and line limit.",
  parameters,
  execute: async (args, context) =>
    capture_errors(async () => {
      const root = require_docs_root(context);
      const target = require_string_arg(args, "path");
      const files = list_doc_files(root);
      const rel = resolve_doc_rel(root, files, target);
      if (rel === undefined) {
        return { ok: false, output: "", error: not_found_error(target, files) };
      }
      try {
        const content = readFileSync(path.join(root, rel), "utf8");
        const body = slice_lines(content, clamp_line_arg(args, "offset", 1), clamp_line_arg(args, "limit", DEFAULT_DOC_LIMIT));
        return { ok: true, output: clamp_output(`# lich doc: ${rel}\n${body}`, MAX_DOC_OUTPUT_CHARS) };
      } catch (err) {
        if (is_enoent(err) === true) {
          return { ok: false, output: "", error: not_found_error(target, files) };
        }
        throw err;
      }
    }),
};