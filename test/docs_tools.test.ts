import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { register_builtin_tools } from "../src/tools/builtin/index.js";
import { docs_search_tool, reset_docs_search_cache } from "../src/tools/builtin/docs_search.js";
import { DOCS_UNAVAILABLE, docs_read_tool, reset_docs_cache, set_docs_root_resolver } from "../src/tools/builtin/docs_read.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolContext, ToolResult } from "../src/tools/types.js";

const TMP_BASE = "/home/moika/nas/code/lich/test/.tmp";

let tmp_root: string;
let fixture_base: string;
let fixture_docs: string;
let empty_dir: string;
let original_cwd: string;

function fixture_context(): ToolContext {
  return { work_dir: empty_dir, env: { LICH_DOCS_DIR: fixture_docs } };
}

const GATEWAY_MD = [
  "# Gateway guide",
  "",
  "The webhook adapter forwards platform events to the agent.",
  "The gateway delivers payloads onward.",
  "",
  "## Webhook events",
  "",
  "The gateway delivers webhook payloads to the endpoint for processing.",
  "",
].join("\n");

const TOOLS_MD = ["# Tools reference", "", "The docs_read tool reads bundled docs files on demand.", ""].join("\n");

const INDEX_MD = [
  "# Lich test docs",
  "",
  "Welcome to the docs fixture for the library.",
  "",
  "## Installation",
  "",
  "Install the library with bun. The library ships docs.",
  "",
].join("\n");

const OVERVIEW_MD = ["# Overview", "", "architecture and the gateway", ""].join("\n");

function expect_ok(result: ToolResult, needle: string): void {
  expect(result.ok).toBe(true);
  expect(result.output).toContain(needle);
}

/** Iterative (stack-based) delete of a directory tree; never throws. */
async function iter_rm(root: string): Promise<void> {
  const dirs: string[] = [];
  const files: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      continue;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      files.push(current);
      continue;
    }
    dirs.push(current);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() === true) {
        stack.push(full);
      } else {
        files.push(full);
      }
    }
  }
  for (const file of files) {
    await remove_quiet(file, true);
  }
  for (let index = dirs.length - 1; index >= 0; index -= 1) {
    const dir = dirs[index];
    if (dir !== undefined) {
      await remove_quiet(dir, false);
    }
  }
}

async function remove_quiet(target: string, is_file: boolean): Promise<void> {
  try {
    if (is_file === true) {
      await unlink(target);
    } else {
      await rmdir(target);
    }
  } catch {
    // best-effort cleanup only
  }
}

beforeAll(async () => {
  original_cwd = process.cwd();
  await mkdir(TMP_BASE, { recursive: true });
  tmp_root = await mkdtemp(path.join(TMP_BASE, "docs-tools-"));
  empty_dir = await mkdtemp(path.join(tmp_root, "empty-"));
  fixture_base = path.join(tmp_root, "docs-fixture");
  fixture_docs = path.join(fixture_base, "docs");
  await mkdir(path.join(fixture_docs, "guide"), { recursive: true });
  await writeFile(path.join(fixture_docs, "index.md"), INDEX_MD);
  await writeFile(path.join(fixture_docs, "guide", "gateway.md"), GATEWAY_MD);
  await writeFile(path.join(fixture_docs, "guide", "tools.md"), TOOLS_MD);
  await writeFile(path.join(fixture_docs, "guide", "overview.md"), OVERVIEW_MD);
});

afterAll(async () => {
  process.chdir(original_cwd);
  await iter_rm(tmp_root);
});

beforeEach(() => {
  delete process.env["LICH_DOCS_DIR"];
  set_docs_root_resolver(undefined);
  reset_docs_cache();
  reset_docs_search_cache();
});

afterEach(() => {
  if (process.cwd() !== original_cwd) {
    process.chdir(original_cwd);
  }
  delete process.env["LICH_DOCS_DIR"];
  set_docs_root_resolver(undefined);
  reset_docs_cache();
  reset_docs_search_cache();
});

describe("docs tool registration", () => {
  it("registers both tools when LICH_DOCS_DIR points at the fixture parent", () => {
    process.env["LICH_DOCS_DIR"] = fixture_base;
    reset_docs_cache();
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    expect(registry.has("docs_read")).toBe(true);
    expect(registry.has("docs_search")).toBe(true);
  });

  it("registers both tools when LICH_DOCS_DIR points at the docs dir itself", () => {
    process.env["LICH_DOCS_DIR"] = fixture_docs;
    reset_docs_cache();
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    expect(registry.has("docs_read")).toBe(true);
    expect(registry.has("docs_search")).toBe(true);
  });

  it("resolves work_dir/docs when env is unset", () => {
    const registry = new ToolRegistry();
    register_builtin_tools(registry, { work_dir: fixture_base, env: {} });
    expect(registry.has("docs_read")).toBe(true);
    expect(registry.has("docs_search")).toBe(true);
  });

  it("skips docs tools silently when no docs root resolves", () => {
    set_docs_root_resolver(() => undefined);
    process.chdir(empty_dir);
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    expect(registry.has("docs_read")).toBe(false);
    expect(registry.has("docs_search")).toBe(false);
    expect(registry.has("read_file")).toBe(true);
  });

  it("resolves the package docs fallback for plain registration", () => {
    process.chdir(original_cwd);
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    expect(registry.has("docs_read")).toBe(true);
    expect(registry.has("docs_search")).toBe(true);
  });
});

describe("docs_read", () => {
  it("reads a doc with and without the .md suffix", async () => {
    const with_suffix = await docs_read_tool.execute({ path: "guide/gateway.md" }, fixture_context());
    expect_ok(with_suffix, "# lich doc: guide/gateway.md");
    expect_ok(with_suffix, "The webhook adapter forwards platform events");
    const without_suffix = await docs_read_tool.execute({ path: "guide/gateway" }, fixture_context());
    expect_ok(without_suffix, "The gateway delivers payloads onward.");
  });

  it("slices by 1-based offset and line limit", async () => {
    const sliced = await docs_read_tool.execute({ path: "guide/gateway.md", offset: 2, limit: 1 }, fixture_context());
    expect(sliced.ok).toBe(true);
    expect(sliced.output).toBe("# lich doc: guide/gateway.md\n");
    const beyond = await docs_read_tool.execute({ path: "guide/gateway.md", offset: 99, limit: 5 }, fixture_context());
    expect(beyond.ok).toBe(true);
    expect(beyond.output).toBe("# lich doc: guide/gateway.md\n");
  });

  it("reports not_found with available paths listed", async () => {
    const missing = await docs_read_tool.execute({ path: "guide/absent.md" }, fixture_context());
    expect(missing.ok).toBe(false);
    expect(missing.error?.startsWith("not_found: guide/absent.md (available: ")).toBe(true);
    expect(missing.error).toContain("guide/gateway.md");
    expect(missing.error).toContain("guide/tools.md");
    expect(missing.error).toContain("index.md");
  });

  it("rejects path escapes and absolute paths", async () => {
    const escape = await docs_read_tool.execute({ path: "../../etc/passwd" }, fixture_context());
    expect(escape.ok).toBe(false);
    expect(escape.error).toContain("path_escape");
    const absolute = await docs_read_tool.execute({ path: "/etc/passwd" }, fixture_context());
    expect(absolute.ok).toBe(false);
    expect(absolute.error).toContain("path_escape");
  });

  it("fails with docs_unavailable when no root resolves", async () => {
    set_docs_root_resolver(() => undefined);
    const context: ToolContext = { work_dir: empty_dir, env: {} };
    const result = await docs_read_tool.execute({ path: "index.md" }, context);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(DOCS_UNAVAILABLE);
  });
});

describe("docs_search", () => {
  it("ranks the webhook section first for a webhook query", async () => {
    const result = await docs_search_tool.execute({ query: "webhook" }, fixture_context());
    expect(result.ok).toBe(true);
    expect(result.output.startsWith("1. guide/gateway.md — ## Webhook events (score 14)")).toBe(true);
    expect(result.output.includes("(score 11)")).toBe(true);
  });

  it("scores heading, filename, and body hits with stable ordering", async () => {
    const result = await docs_search_tool.execute({ query: "gateway" }, fixture_context());
    expect(result.ok).toBe(true);
    expect(result.output.startsWith("1. guide/gateway.md — # guide/gateway.md (score 17)")).toBe(true);
    expect(result.output.includes("2. guide/gateway.md — ## Webhook events (score 13)")).toBe(true);
    expect(result.output.includes("3. guide/overview.md — # guide/overview.md (score 11)")).toBe(true);
  });

  it("awards the exact-phrase bonus", async () => {
    const result = await docs_search_tool.execute({ query: "delivers payloads" }, fixture_context());
    expect(result.ok).toBe(true);
    expect(result.output.startsWith("1. guide/gateway.md — # guide/gateway.md (score 12)")).toBe(true);
    expect(result.output.includes("(score 2)")).toBe(true);
  });

  it("reports no results for unknown queries", async () => {
    const result = await docs_search_tool.execute({ query: "xzyqqqq" }, fixture_context());
    expect_ok(result, "no results for: xzyqqqq");
  });

  it("caps results at max_results", async () => {
    const result = await docs_search_tool.execute({ query: "gateway", max_results: 1 }, fixture_context());
    expect_ok(result, "(score 17)");
    expect(result.output.includes("2. ")).toBe(false);
  });

  it("requires a non-empty query", async () => {
    const no_arg = await docs_search_tool.execute({}, fixture_context());
    expect(no_arg.ok).toBe(false);
    expect(no_arg.error).toContain("missing_arg: query");
  });

  it("fails with docs_unavailable when no root resolves", async () => {
    set_docs_root_resolver(() => undefined);
    const context: ToolContext = { work_dir: empty_dir, env: {} };
    const result = await docs_search_tool.execute({ query: "gateway" }, context);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(DOCS_UNAVAILABLE);
  });
});