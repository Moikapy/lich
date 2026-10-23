import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, unlink, rmdir, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import {
  clamp_output,
  optional_boolean_arg,
  optional_number_arg,
  require_string_arg,
  resolve_safe_path,
  with_timeout,
} from "../src/tools/guard.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { default_tool_context, ToolRegistry } from "../src/tools/registry.js";
import { builtin_toolset, register_builtin_tools } from "../src/tools/builtin/index.js";
import { scrub_spawn_env, terminal_tool } from "../src/tools/builtin/terminal.js";
import type { Tool, ToolContext, ToolResult } from "../src/tools/types.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

let tmp_root: string;

function make_tool(name: string, run: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>): Tool {
  return {
    name,
    description: `fake ${name}`,
    parameters: { type: "object" },
    execute: run,
  };
}

async function write_temp(root: string, relative: string, content: string | Buffer): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function read_temp(root: string, relative: string): Promise<string> {
  return readFile(path.join(root, relative), "utf8");
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
    await rm_quiet(file, true);
  }
  for (let index = dirs.length - 1; index >= 0; index -= 1) {
    const dir = dirs[index];
    if (dir !== undefined) {
      await rm_quiet(dir, false);
    }
  }
}

async function rm_quiet(target: string, is_file: boolean): Promise<void> {
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

function make_executor(registry: ToolRegistry): ToolExecutor {
  return new ToolExecutor(registry, { work_dir: tmp_root, env: {} });
}

beforeAll(async () => {
  await mkdir(TMP_BASE, { recursive: true });
  tmp_root = await mkdtemp(path.join(TMP_BASE, "tools-"));
});

/** Dirs created outside tmp_root by the symlink tests. */
const outside_dirs: string[] = [];

afterAll(async () => {
  await iter_rm(tmp_root);
  for (const dir of outside_dirs) {
    await iter_rm(dir);
  }
});

describe("guard", () => {
  it("resolve_safe_path rejects escapes", () => {
    expect(() => resolve_safe_path(tmp_root, "../../etc/passwd")).toThrow(/path_escape/);
    expect(() => resolve_safe_path(tmp_root, "/etc/passwd")).toThrow(/path_escape/);
  });

  it("resolve_safe_path accepts a name that only starts with two dots", () => {
    expect(resolve_safe_path(tmp_root, "..notes.txt")).toBe(path.join(tmp_root, "..notes.txt"));
    expect(() => resolve_safe_path(tmp_root, "..")).toThrow(/path_escape/);
  });

  it("resolve_safe_path accepts inside paths", () => {
    const relative = resolve_safe_path(tmp_root, "./sub/file.txt");
    expect(relative.startsWith(tmp_root) === true).toBe(true);
    const absolute = resolve_safe_path(tmp_root, path.join(tmp_root, "inner.txt"));
    expect(absolute.startsWith(tmp_root) === true).toBe(true);
  });

  it("require_string_arg errors on missing/empty/non-string", () => {
    expect(() => require_string_arg({}, "path")).toThrow(/missing_arg: path/);
    expect(() => require_string_arg({ path: "" }, "path")).toThrow(/missing_arg: path/);
    expect(() => require_string_arg({ path: 5 }, "path")).toThrow(/missing_arg: path/);
    expect(require_string_arg({ path: "x" }, "path")).toBe("x");
  });

  it("optional args coerce or fall back", () => {
    expect(optional_number_arg({ n: 7 }, "n", 1)).toBe(7);
    expect(optional_number_arg({ n: "x" }, "n", 1)).toBe(1);
    expect(optional_boolean_arg({ b: true }, "b", false)).toBe(true);
    expect(optional_boolean_arg({}, "b", false)).toBe(false);
  });

  it("clamp_output truncates via truncate_text", () => {
    const long = "x".repeat(25000);
    const clamped = clamp_output(long, 100);
    expect(clamped.length < 25000).toBe(true);
    expect(clamped.startsWith("xxx") === true).toBe(true);
    expect(clamped.includes("truncated") === true).toBe(true);
  });

  it("with_timeout rejects quickly and aborts signal", async () => {
    const started = Date.now();
    await expect(
      with_timeout(async (signal) => {
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }, 50, "test"),
    ).rejects.toThrow(/timeout: test/);
    expect(Date.now() - started < 2000).toBe(true);
  });
});

describe("registry", () => {
  it("registers, detects duplicates, lists and maps definitions", () => {
    const registry = new ToolRegistry();
    registry.register(make_tool("fake_one", async () => ({ ok: true, output: "" })));
    expect(() => registry.register(make_tool("fake_one", async () => ({ ok: true, output: "" })))).toThrow(/duplicate_tool/);
    expect(registry.has("fake_one") === true).toBe(true);
    expect(registry.get("missing") === undefined).toBe(true);
    const definitions = registry.definitions();
    expect(definitions.length === 1).toBe(true);
    expect(definitions[0]?.name).toBe("fake_one");
    expect(definitions[0]?.parameters.type).toBe("object");
  });

  it("register_builtin_tools registers the twelve core builtins", () => {
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    // Docs tools register only when a docs root resolves (e.g. this repo),
    // so the floor here is the twelve core builtins.
    expect(registry.list().length >= 12).toBe(true);
    for (const name of [
      "read_file",
      "write_file",
      "edit_file",
      "list_dir",
      "terminal",
      "grep_files",
      "fetch_url",
      "web_search",
      "http_request",
      "process_list",
      "disk_usage",
      "env_get",
    ]) {
      expect(registry.has(name) === true).toBe(true);
    }
    expect(builtin_toolset.name).toBe("builtin");
  });

  it("default_tool_context fills env", () => {
    const context = default_tool_context("/tmp-place", { A: "1" });
    expect(context.work_dir).toBe("/tmp-place");
    expect(context.env.A).toBe("1");
  });
});

describe("executor", () => {
  it("unknown tool yields unknown_tool error", async () => {
    const executor = make_executor(new ToolRegistry());
    const result = await executor.execute("nope", {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unknown_tool: nope");
  });

  it("catches thrown errors from tools", async () => {
    const registry = new ToolRegistry();
    registry.register(make_tool("boom", async () => {
      throw new Error("kaboom");
    }));
    const executor = make_executor(registry);
    const result = await executor.execute("boom", {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("kaboom");
  });

  it("returns cancelled for pre-aborted context", async () => {
    const registry = new ToolRegistry();
    registry.register(make_tool("slow_ok", async () => ({ ok: true, output: "fine" })));
    const executor = make_executor(registry);
    const controller = new AbortController();
    controller.abort();
    const result = await executor.execute("slow_ok", {}, { work_dir: tmp_root, env: {}, signal: controller.signal });
    expect(result.error).toBe("cancelled");
  });

  it("format_result renders JSON on error and raw output otherwise", () => {
    const error_json = ToolExecutor.format_result({ ok: false, output: "", error: "bad" });
    expect(error_json.startsWith("{") === true).toBe(true);
    expect(error_json.includes("bad") === true).toBe(true);
    expect(ToolExecutor.format_result({ ok: true, output: "plain" })).toBe("plain");
  });

  it("honors a tool-declared timeout_ms over the 30s default", async () => {
    const registry = new ToolRegistry();
    const hanging: Tool = {
      ...make_tool("hanging", () => new Promise<ToolResult>(() => undefined)),
      timeout_ms: 150,
    };
    registry.register(hanging);
    const executor = make_executor(registry);
    const started = Date.now();
    const result = await executor.execute("hanging", {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("timeout: tool:hanging exceeded 150ms");
    expect(Date.now() - started < 2000).toBe(true);
  });

  it("terminal defaults its timeout to config terminal_timeout_ms", async () => {
    const context: ToolContext = { work_dir: tmp_root, env: { LICH_TERMINAL_TIMEOUT_MS: "200" } };
    const started = Date.now();
    const result = await terminal_tool.execute({ command: "sleep 5" }, context);
    expect(result.error).toBe("timeout");
    expect(Date.now() - started < 4000).toBe(true);
  });

  it("ignores a non-positive or non-numeric terminal_timeout_ms instead of killing at once", async () => {
    for (const configured of ["0", "-5", "nope", ""]) {
      const context: ToolContext = { work_dir: tmp_root, env: { LICH_TERMINAL_TIMEOUT_MS: configured } };
      const result = await terminal_tool.execute({ command: "sleep 0.2" }, context);
      expect(result.ok, configured).toBe(true);
      expect(result.error, configured).toBeUndefined();
    }
  });

  it("terminal declares a 300000ms executor timeout", () => {
    expect(terminal_tool.timeout_ms).toBe(300000);
  });
});

describe("read/write/edit", () => {
  it("write then read round trip", async () => {
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    const executor = make_executor(registry);
    const written = await executor.execute("write_file", { path: "rw/hello.txt", content: "alpha\nbeta\n" });
    expect(written.ok).toBe(true);
    expect(written.output).toBe(`wrote ${"alpha\nbeta\n".length} chars to rw/hello.txt`);
    const read = await executor.execute("read_file", { path: "rw/hello.txt" });
    expect(read.ok).toBe(true);
    expect(read.output).toBe("alpha\nbeta\n");
    const offset = await executor.execute("read_file", { path: "rw/hello.txt", offset: 2, limit: 1 });
    expect(offset.ok).toBe(true);
    expect(offset.output).toBe("beta");
  });

  it("read_file reports not_found", async () => {
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    const executor = make_executor(registry);
    const result = await executor.execute("read_file", { path: "rw/absent.txt" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_found: rw/absent.txt");
  });

  it("edit_file replaces a unique match", async () => {
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    const executor = make_executor(registry);
    await executor.execute("write_file", { path: "edit/one.txt", content: "aaa bbb aaa\n" });
    const edited = await executor.execute("edit_file", { path: "edit/one.txt", old_string: "bbb", new_string: "ccc" });
    expect(edited.ok).toBe(true);
    expect(edited.output).toBe("edited edit/one.txt (replaced 1 occurrence(s))");
    expect(await read_temp(tmp_root, "edit/one.txt")).toBe("aaa ccc aaa\n");
  });

  it("edit_file errors on missing and non-unique matches", async () => {
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    const executor = make_executor(registry);
    const missing = await executor.execute("edit_file", { path: "edit/one.txt", old_string: "zzz", new_string: "y" });
    expect(missing.error).toBe("old_string_not_found");
    const not_unique = await executor.execute("edit_file", { path: "edit/one.txt", old_string: "aaa", new_string: "q" });
    expect(not_unique.ok).toBe(false);
    expect(not_unique.error?.includes("old_string_not_unique (2 occurrences)")).toBe(true);
  });

  it("edit_file replace_all replaces every occurrence", async () => {
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    const executor = make_executor(registry);
    await executor.execute("write_file", { path: "edit/two.txt", content: "x-y-x" });
    const result = await executor.execute("edit_file", {
      path: "edit/two.txt",
      old_string: "x",
      new_string: "z",
      replace_all: true,
    });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("edited edit/two.txt (replaced 2 occurrence(s))");
    expect(await read_temp(tmp_root, "edit/two.txt")).toBe("z-y-z");
  });
});

describe("list_dir", () => {
  it("lists entries, skips node_modules, honors depth", async () => {
    await write_temp(tmp_root, "list/sub/inner.txt", "x");
    await write_temp(tmp_root, "list/alpha.txt", "hello");
    await write_temp(tmp_root, "list/node_modules/junk.js", "y");
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    const executor = make_executor(registry);
    const result = await executor.execute("list_dir", { path: "list", depth: 2 });
    expect(result.ok).toBe(true);
    expect(result.output.includes("d sub/")).toBe(true);
    expect(result.output.includes("- inner.txt")).toBe(true);
    expect(result.output.includes("- alpha.txt")).toBe(true);
    expect(result.output.includes("node_modules")).toBe(false);
  });

  it("skips .git, dist, and .cursor so their contents stay out of the listing and grep", async () => {
    await write_temp(tmp_root, "skip/keep.txt", "keep-marker\n");
    await write_temp(tmp_root, "skip/.git/config", "git-token-marker\n");
    await write_temp(tmp_root, "skip/dist/bundle.js", "dist-marker\n");
    await write_temp(tmp_root, "skip/.cursor/rules.md", "cursor-marker\n");
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    const executor = make_executor(registry);
    const listed = await executor.execute("list_dir", { path: "skip", depth: 3 });
    expect(listed.ok).toBe(true);
    expect(listed.output).toContain("keep.txt");
    expect(listed.output).not.toContain(".git");
    expect(listed.output).not.toContain("dist");
    expect(listed.output).not.toContain(".cursor");
    const grepped = await executor.execute("grep_files", { pattern: "marker", path: "skip" });
    expect(grepped.ok).toBe(true);
    expect(grepped.output).toContain("keep-marker");
    expect(grepped.output).not.toContain("git-token-marker");
    expect(grepped.output).not.toContain("dist-marker");
    expect(grepped.output).not.toContain("cursor-marker");
  });

  it("clamps depth into 1..4 so a deep tree stops before the fifth level", async () => {
    await write_temp(tmp_root, "depth/l1.txt", "x");
    await write_temp(tmp_root, "depth/d1/l2.txt", "x");
    await write_temp(tmp_root, "depth/d1/d2/l3.txt", "x");
    await write_temp(tmp_root, "depth/d1/d2/d3/l4.txt", "x");
    await write_temp(tmp_root, "depth/d1/d2/d3/d4/l5.txt", "x");
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    const executor = make_executor(registry);
    const shallow = await executor.execute("list_dir", { path: "depth", depth: 0 });
    expect(shallow.ok).toBe(true);
    expect(shallow.output).toContain("l1.txt");
    expect(shallow.output).toContain("d d1/");
    expect(shallow.output).not.toContain("l2.txt");
    const negative = await executor.execute("list_dir", { path: "depth", depth: -2 });
    expect(negative.output).toBe(shallow.output);
    const fractional = await executor.execute("list_dir", { path: "depth", depth: 2.9 });
    expect(fractional.output).toContain("l2.txt");
    expect(fractional.output).not.toContain("l3.txt");
    const at_cap = await executor.execute("list_dir", { path: "depth", depth: 4 });
    const over = await executor.execute("list_dir", { path: "depth", depth: 100 });
    expect(over.output).toBe(at_cap.output);
    expect(at_cap.output).toContain("l4.txt");
    expect(at_cap.output).toContain("d d4/");
    expect(at_cap.output).not.toContain("l5.txt");
  });

  it("stops at 500 entries and reports the truncation", async () => {
    const dir = path.join(tmp_root, "list-cap");
    await mkdir(dir, { recursive: true });
    for (let index = 0; index <= 500; index += 1) {
      const name = `f-${String(index).padStart(3, "0")}.txt`;
      await writeFile(path.join(dir, name), "x");
    }
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    const executor = make_executor(registry);
    const result = await executor.execute("list_dir", { path: "list-cap", depth: 1 });
    expect(result.ok).toBe(true);
    const lines = result.output.split("\n");
    expect(lines.at(-1)).toBe("(... truncated at 500 entries)");
    expect(lines.filter((line) => line.startsWith("- f-"))).toHaveLength(500);
    expect(result.output).toContain("f-000.txt");
    expect(result.output).not.toContain("f-500.txt");
  });
});

describe("terminal", () => {
  it("echoes hello with exit code line and context env", async () => {
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    const executor = new ToolExecutor(registry, { work_dir: tmp_root, env: { LICH_TEST_VAR: "lich_env" } });
    const result = await executor.execute("terminal", { command: "echo hello $LICH_TEST_VAR" });
    expect(result.ok).toBe(true);
    expect(result.output.includes("hello lich_env")).toBe(true);
    expect(result.output.includes("[exit 0]")).toBe(true);
  });

  it("scrubs secret-ish env names from the spawned shell", async () => {
    const prev = process.env.FAKE_API_KEY;
    process.env.FAKE_API_KEY = "should-not-leak";
    try {
      expect(scrub_spawn_env(process.env, {}).FAKE_API_KEY).toBeUndefined();
      const registry = new ToolRegistry();
      register_builtin_tools(registry);
      const executor = make_executor(registry);
      const result = await executor.execute("terminal", { command: "printenv FAKE_API_KEY || true" });
      expect(result.ok).toBe(true);
      expect(result.output.includes("should-not-leak")).toBe(false);
    } finally {
      if (prev === undefined) {
        delete process.env.FAKE_API_KEY;
      } else {
        process.env.FAKE_API_KEY = prev;
      }
    }
  });

  it("propagates non-zero exit codes", async () => {
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    const executor = make_executor(registry);
    const result = await executor.execute("terminal", { command: "exit 3" });
    expect(result.ok).toBe(false);
    expect(result.output.includes("[exit 3]")).toBe(true);
    expect(result.error === undefined).toBe(true);
  });

  it("kills long commands on timeout", async () => {
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    const executor = make_executor(registry);
    const started = Date.now();
    const result = await executor.execute("terminal", { command: "sleep 5", timeout_ms: 300 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("timeout");
    expect(Date.now() - started < 5000).toBe(true);
  });
});


describe("symlink confinement", () => {
  it("rejects file-tool paths that symlink outside work_dir", async () => {
    const outside = await mkdtemp(path.join(TMP_BASE, "outside-"));
    outside_dirs.push(outside);
    await writeFile(path.join(outside, "secret.txt"), "leak\n", "utf8");
    symlinkSync(outside, path.join(tmp_root, "escape_link"));
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    const executor = make_executor(registry);
    const read = await executor.execute("read_file", { path: "escape_link/secret.txt" });
    expect(read.ok).toBe(false);
    expect(read.error?.startsWith("path_escape")).toBe(true);
    const written = await executor.execute("write_file", { path: "escape_link/planted.txt", content: "nope" });
    expect(written.ok).toBe(false);
    expect(written.error?.startsWith("path_escape")).toBe(true);
    const listed = await executor.execute("list_dir", { path: "escape_link" });
    expect(listed.ok).toBe(false);
    expect(listed.error?.startsWith("path_escape")).toBe(true);
  });

  it("rejects writing through a symlink leaf that points outside", async () => {
    const outside = await mkdtemp(path.join(TMP_BASE, "outside-leaf-"));
    outside_dirs.push(outside);
    const outside_file = path.join(outside, "target.txt");
    await writeFile(outside_file, "before\n", "utf8");
    symlinkSync(outside_file, path.join(tmp_root, "leaf_link.txt"));
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    const executor = make_executor(registry);
    const written = await executor.execute("write_file", { path: "leaf_link.txt", content: "after\n" });
    expect(written.ok).toBe(false);
    expect(written.error?.startsWith("path_escape")).toBe(true);
    expect(await readFile(outside_file, "utf8")).toBe("before\n");
  });

  it("resolves an in-ward directory symlink and still refuses symlink-leaf writes", async () => {
    await write_temp(tmp_root, "inward/note.txt", "kept\n");
    symlinkSync(path.join(tmp_root, "inward"), path.join(tmp_root, "inward_alias"));
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    const executor = make_executor(registry);
    const read = await executor.execute("read_file", { path: "inward_alias/note.txt" });
    expect(read.ok).toBe(true);
    expect(read.output).toBe("kept\n");
    const created = await executor.execute("write_file", { path: "inward_alias/fresh.txt", content: "new\n" });
    expect(created.ok).toBe(true);
    expect(await read_temp(tmp_root, "inward/fresh.txt")).toBe("new\n");
    symlinkSync(path.join(tmp_root, "inward", "note.txt"), path.join(tmp_root, "note_alias.txt"));
    const overwritten = await executor.execute("write_file", { path: "note_alias.txt", content: "changed\n" });
    expect(overwritten.ok).toBe(false);
    expect(overwritten.error?.startsWith("path_escape")).toBe(true);
    const edited = await executor.execute("edit_file", {
      path: "note_alias.txt",
      old_string: "kept",
      new_string: "lost",
    });
    expect(edited.ok).toBe(false);
    expect(edited.error?.startsWith("path_escape")).toBe(true);
    expect(await read_temp(tmp_root, "inward/note.txt")).toBe("kept\n");
  });

  it("denies symlinks that resolve onto .lich identity files", async () => {
    await write_temp(tmp_root, ".lich/config.json", '{"api_key":"sk-alias-secret"}\n');
    await write_temp(tmp_root, ".lich/profiles/coder.md", "secret-soul\n");
    await mkdir(path.join(tmp_root, "nest"), { recursive: true });
    symlinkSync(path.join("..", ".lich", "config.json"), path.join(tmp_root, "nest", "config_alias.json"));
    symlinkSync(path.join(".lich", "profiles", "coder.md"), path.join(tmp_root, "soul_alias.md"));
    symlinkSync(path.join(".lich", "profiles"), path.join(tmp_root, "profiles_alias"));
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    const executor = make_executor(registry);
    const config_read = await executor.execute("read_file", { path: "nest/config_alias.json" });
    expect(config_read.ok).toBe(false);
    expect(config_read.output).toBe("");
    expect(config_read.error?.startsWith("forbidden_path: .lich/config.json")).toBe(true);
    expect(config_read.error).not.toContain("sk-alias-secret");
    const soul_read = await executor.execute("read_file", { path: "soul_alias.md" });
    expect(soul_read.ok).toBe(false);
    expect(soul_read.error?.startsWith("forbidden_path: .lich/profiles")).toBe(true);
    expect(soul_read.error).not.toContain("secret-soul");
    const nested = await executor.execute("read_file", { path: "profiles_alias/coder.md" });
    expect(nested.ok).toBe(false);
    expect(nested.error?.startsWith("forbidden_path: .lich/profiles")).toBe(true);
    const planted = await executor.execute("write_file", { path: "profiles_alias/planted.md", content: "pwn\n" });
    expect(planted.ok).toBe(false);
    expect(planted.error?.startsWith("forbidden_path: .lich/profiles")).toBe(true);
    await expect(readFile(path.join(tmp_root, ".lich", "profiles", "planted.md"), "utf8")).rejects.toThrow();
    const listed = await executor.execute("list_dir", { path: "profiles_alias" });
    expect(listed.ok).toBe(false);
    expect(listed.error?.startsWith("forbidden_path: .lich/profiles")).toBe(true);
    const usage = await executor.execute("disk_usage", { path: "profiles_alias" });
    expect(usage.ok).toBe(false);
    expect(usage.error?.startsWith("forbidden_path: .lich/profiles")).toBe(true);
    const grepped = await executor.execute("grep_files", { pattern: "api_key|secret-soul", path: "nest/config_alias.json" });
    expect(grepped.ok).toBe(false);
    expect(grepped.output).toBe("");
    expect(grepped.error?.startsWith("forbidden_path: .lich/config.json")).toBe(true);
    expect(grepped.error).not.toContain("sk-alias-secret");
    expect(await read_temp(tmp_root, ".lich/config.json")).toContain("sk-alias-secret");
    expect(await read_temp(tmp_root, ".lich/profiles/coder.md")).toBe("secret-soul\n");
  });
});

describe("forbidden file paths", () => {
  it("denies .lich/config.json to read/write/edit", async () => {
    await mkdir(path.join(tmp_root, ".lich"), { recursive: true });
    await writeFile(path.join(tmp_root, ".lich", "config.json"), '{"ok":true}\n', "utf8");
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    const executor = make_executor(registry);
    const read = await executor.execute("read_file", { path: ".lich/config.json" });
    expect(read.error?.startsWith("forbidden_path")).toBe(true);
    const write = await executor.execute("write_file", { path: ".lich/config.json", content: "{}\n" });
    expect(write.error?.startsWith("forbidden_path")).toBe(true);
  });

  it("denies .lich/profiles to read and write (global identity files when work_dir is home)", async () => {
    await mkdir(path.join(tmp_root, ".lich", "profiles"), { recursive: true });
    await writeFile(path.join(tmp_root, ".lich", "profiles", "coder.md"), "soul\n", "utf8");
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    const executor = make_executor(registry);
    const read = await executor.execute("read_file", { path: ".lich/profiles/coder.md" });
    expect(read.error?.startsWith("forbidden_path: .lich/profiles")).toBe(true);
    const write = await executor.execute("write_file", { path: ".lich/profiles/coder.json", content: "{}\n" });
    expect(write.error?.startsWith("forbidden_path")).toBe(true);
    const listed = await executor.execute("list_dir", { path: ".lich/profiles" });
    expect(listed.error?.startsWith("forbidden_path: .lich/profiles")).toBe(true);
    const walked = await executor.execute("list_dir", { path: ".lich", depth: 3 });
    expect(walked.ok).toBe(true);
    expect(walked.output).not.toContain("profiles");
    expect(walked.output).not.toContain("coder.md");
    const usage = await executor.execute("disk_usage", { path: ".lich/profiles" });
    expect(usage.error?.startsWith("forbidden_path: .lich/profiles")).toBe(true);
    const parent = await executor.execute("disk_usage", { path: ".lich" });
    if (parent.error !== "du_unavailable") {
      expect(parent.ok).toBe(true);
      expect(parent.output).not.toContain("profiles");
    }
  });

  it("allows writes under .lich/skills and .lich/plugins; denies other .lich writes and .env*", async () => {
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    const executor = make_executor(registry);
    const skill = await executor.execute("write_file", { path: ".lich/skills/demo.md", content: "# demo\n" });
    expect(skill.ok).toBe(true);
    const plugin = await executor.execute("write_file", { path: ".lich/plugins/greet.ts", content: "export default {}\n" });
    expect(plugin.ok).toBe(true);
    const other = await executor.execute("write_file", { path: ".lich/sessions/x.jsonl", content: "{}\n" });
    expect(other.error?.startsWith("forbidden_path")).toBe(true);
    const env_file = await executor.execute("write_file", { path: ".env", content: "X=1\n" });
    expect(env_file.error?.startsWith("forbidden_path")).toBe(true);
    const env_local = await executor.execute("write_file", { path: ".env.local", content: "X=1\n" });
    expect(env_local.error?.startsWith("forbidden_path")).toBe(true);
  });
});

describe("grep_files", () => {
  it("matches lines with path:lineNo format and skips node_modules and binary files", async () => {
    await write_temp(tmp_root, "grep/a.ts", "const alpha_value = 1;\nconst beta_value = 2;\n");
    await write_temp(tmp_root, "grep/b.ts", "const gamma_value = 3;\n");
    await write_temp(tmp_root, "grep/node_modules/c.ts", "const alpha_value = 99;\n");
    await write_temp(tmp_root, "grep/bin.dat", Buffer.from([0, 1, 2, 97, 108, 112, 104, 97]));
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    const executor = make_executor(registry);
    const result = await executor.execute("grep_files", { pattern: "alpha_value", path: "grep" });
    expect(result.ok).toBe(true);
    expect(result.output.includes("a.ts:1: const alpha_value = 1;")).toBe(true);
    expect(result.output.includes("node_modules")).toBe(false);
    expect(result.output.includes("bin.dat")).toBe(false);
  });

  it("filters by glob and reports invalid regex", async () => {
    await write_temp(tmp_root, "grep2/a.ts", "target_here\n");
    await write_temp(tmp_root, "grep2/a.md", "target_here\n");
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    const executor = make_executor(registry);
    const ts_only = await executor.execute("grep_files", { pattern: "target_here", path: "grep2", glob: "*.ts" });
    expect(ts_only.output.includes("a.ts:1: target_here")).toBe(true);
    expect(ts_only.output.includes("a.md")).toBe(false);
    const bad = await executor.execute("grep_files", { pattern: "[unclosed", path: "grep2" });
    expect(bad.ok).toBe(false);
    expect(bad.error?.includes("invalid_regex")).toBe(true);
  });

  it("skips a file at the 1_000_000 byte cap and still reads one byte under it", async () => {
    const huge = Buffer.alloc(1_000_000, 0x61);
    Buffer.from("HUGE_MARKER\n").copy(huge);
    const almost = Buffer.alloc(999_999, 0x61);
    Buffer.from("ALMOST_MARKER\n").copy(almost);
    await write_temp(tmp_root, "grep-size/huge.txt", huge);
    await write_temp(tmp_root, "grep-size/almost.txt", almost);
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    const executor = make_executor(registry);
    const result = await executor.execute("grep_files", {
      pattern: "HUGE_MARKER|ALMOST_MARKER",
      path: "grep-size",
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("almost.txt");
    expect(result.output).toContain("ALMOST_MARKER");
    expect(result.output).not.toContain("huge.txt");
    expect(result.output).not.toContain("HUGE_MARKER");
  });

  it("treats a NUL only inside the first 1000 bytes as binary", async () => {
    const late = Buffer.concat([
      Buffer.alloc(1000, 0x61),
      Buffer.from([0]),
      Buffer.from("LATE_NUL_MARKER\n"),
    ]);
    const early = Buffer.concat([Buffer.from([0]), Buffer.from("EARLY_NUL_MARKER\n")]);
    await write_temp(tmp_root, "grep-nul/late.txt", late);
    await write_temp(tmp_root, "grep-nul/early.dat", early);
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    const executor = make_executor(registry);
    const result = await executor.execute("grep_files", {
      pattern: "LATE_NUL_MARKER|EARLY_NUL_MARKER",
      path: "grep-nul",
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("late.txt");
    expect(result.output).toContain("LATE_NUL_MARKER");
    expect(result.output).not.toContain("early.dat");
    expect(result.output).not.toContain("EARLY_NUL_MARKER");
  });

  it("does not follow a symlink onto another file while scanning a directory", async () => {
    await write_temp(tmp_root, "grep-link/note.txt", "LINK_MARKER\n");
    symlinkSync("note.txt", path.join(tmp_root, "grep-link", "alias.txt"));
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    const executor = make_executor(registry);
    const result = await executor.execute("grep_files", { pattern: "LINK_MARKER", path: "grep-link" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("note.txt");
    expect(result.output).not.toContain("alias.txt");
  });

  it("matches a prefix glob and an exact filename", async () => {
    await write_temp(tmp_root, "grep-glob/pre.txt", "GLOB_MARKER\n");
    await write_temp(tmp_root, "grep-glob/other.txt", "GLOB_MARKER\n");
    await write_temp(tmp_root, "grep-glob/exact.txt", "GLOB_MARKER\n");
    const registry = new ToolRegistry();
    register_builtin_tools(registry);
    const executor = make_executor(registry);
    const prefix = await executor.execute("grep_files", {
      pattern: "GLOB_MARKER",
      path: "grep-glob",
      glob: "pre*",
    });
    expect(prefix.ok).toBe(true);
    expect(prefix.output).toContain("pre.txt");
    expect(prefix.output).not.toContain("other.txt");
    expect(prefix.output).not.toContain("exact.txt");
    const exact = await executor.execute("grep_files", {
      pattern: "GLOB_MARKER",
      path: "grep-glob",
      glob: "exact.txt",
    });
    expect(exact.output).toContain("exact.txt");
    expect(exact.output).not.toContain("pre.txt");
  });
});