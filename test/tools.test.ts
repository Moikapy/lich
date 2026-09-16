import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { terminal_tool } from "../src/tools/builtin/terminal.js";
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

afterAll(async () => {
  await iter_rm(tmp_root);
});

describe("guard", () => {
  it("resolve_safe_path rejects escapes", () => {
    expect(() => resolve_safe_path(tmp_root, "../../etc/passwd")).toThrow(/path_escape/);
    expect(() => resolve_safe_path(tmp_root, "/etc/passwd")).toThrow(/path_escape/);
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
});