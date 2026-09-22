/**
 * Should-fix tools leftovers from issue #39: S-6..S-9.
 */
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { register_builtin_tools } from "../src/tools/builtin/index.js";
import { reset_test_command_runner, set_test_command_runner } from "../src/tools/builtin/run_tests.js";
import type { TestCommandRunner } from "../src/tools/builtin/run_tests.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { read_clamped_text, reject_oversized_content_length } from "../src/tools/read_clamped.js";
import { reset_url_guard_fetch, set_url_guard_fetch } from "../src/tools/url_guard.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const temp_dirs: string[] = [];
const real_fetch: typeof fetch = globalThis.fetch;

afterAll(async () => {
  for (const dir of temp_dirs) {
    await rm(dir, { recursive: true, force: true });
  }
  reset_test_command_runner();
  reset_url_guard_fetch();
  globalThis.fetch = real_fetch;
});

afterEach(() => {
  reset_test_command_runner();
  reset_url_guard_fetch();
  globalThis.fetch = real_fetch;
});

async function make_temp_dir(): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(path.join(TMP_BASE, "tools-should-"));
  temp_dirs.push(dir);
  return dir;
}

function make_executor(work_dir: string): ToolExecutor {
  const registry = new ToolRegistry();
  register_builtin_tools(registry);
  return new ToolExecutor(registry, { work_dir, env: {} });
}

describe("S-6 terminal process-group kill", () => {
  it("kills grandchildren on timeout and returns quickly with ok:false", async () => {
    const work = await make_temp_dir();
    const executor = make_executor(work);
    const started = Date.now();
    const result = await executor.execute("terminal", {
      command: "sleep 7; echo done",
      timeout_ms: 300,
    });
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("timeout");
    expect(elapsed).toBeLessThan(2500);
    expect(result.output.includes("done")).toBe(false);
  });

  it("does not report ok:true together with a timeout error", async () => {
    const work = await make_temp_dir();
    const executor = make_executor(work);
    const result = await executor.execute("terminal", {
      command: "sleep 5",
      timeout_ms: 200,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("timeout");
  });
});

describe("S-7 run_tests timeout clears mutex", () => {
  it("times out a hanging runner and lets a later call proceed", async () => {
    const work = await make_temp_dir();
    const executor = make_executor(work);
    let release: (() => void) | undefined;
    const hanging: TestCommandRunner = async (_cmd, _cwd, _on_chunk, signal) => {
      await new Promise<void>((resolve) => {
        release = resolve;
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { exit_code: -1 };
    };
    set_test_command_runner(hanging);
    const first = await executor.execute("run_tests", { timeout_ms: 150 }, { work_dir: work, env: {} });
    expect(first.ok).toBe(false);
    expect(first.error).toBe("timeout");
    release?.();
    set_test_command_runner(async () => ({ exit_code: 0 }));
    const second = await executor.execute("run_tests", {}, { work_dir: work, env: {} });
    expect(second.ok).toBe(true);
  });
});

describe("S-8 grep_files ReDoS caps", () => {
  it("caps line length so a pathological regex returns quickly", async () => {
    const work = await make_temp_dir();
    const long_line = `${"a".repeat(80)}b`;
    await writeFile(path.join(work, "evil.txt"), `${long_line}\n`, "utf8");
    const executor = make_executor(work);
    const started = Date.now();
    const result = await executor.execute("grep_files", {
      pattern: "^(a+)+$",
      path: "evil.txt",
    });
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(300);
  });

  it("clamps max_results to the hard ceiling", async () => {
    const work = await make_temp_dir();
    const lines = Array.from({ length: 50 }, (_, i) => `hit_${i}`).join("\n");
    await writeFile(path.join(work, "many.txt"), `${lines}\n`, "utf8");
    const executor = make_executor(work);
    const result = await executor.execute("grep_files", {
      pattern: "hit_",
      path: "many.txt",
      max_results: 999999,
    });
    expect(result.ok).toBe(true);
    const match_lines = result.output.split("\n").filter((line) => line.includes("hit_"));
    expect(match_lines.length).toBeLessThanOrEqual(2000);
  });
});

describe("S-9 HTTP stream clamp", () => {
  it("rejects oversized content-length before buffering", () => {
    const response = new Response("tiny", {
      status: 200,
      headers: { "content-length": String(50_000_000) },
    });
    expect(() => reject_oversized_content_length(response, 1000)).toThrow(/body_too_large/);
  });

  it("streams only up to the byte budget from a ReadableStream body", async () => {
    const chunk = new Uint8Array(1000).fill(65);
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        if (reads > 20) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const response = new Response(stream, { status: 200, headers: { "content-type": "text/plain" } });
    const clamped = await read_clamped_text(response, 2500);
    expect(clamped.bytes_read).toBe(2500);
    expect(clamped.truncated).toBe(true);
    expect(clamped.text.length).toBe(2500);
    expect(reads).toBeLessThan(10);
  });

  it("fetch_url fails closed on oversized content-length via mock", async () => {
    const work = await make_temp_dir();
    const executor = make_executor(work);
    set_url_guard_fetch(async () =>
      new Response("x", {
        status: 200,
        headers: { "content-type": "text/plain", "content-length": "90000000" },
      }),
    );
    const result = await executor.execute("fetch_url", { url: "https://example.com/huge", max_chars: 10 });
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toMatch(/body_too_large/);
  });

  it("http_request streams a capped body via mock", async () => {
    const work = await make_temp_dir();
    const executor = make_executor(work);
    const payload = "Z".repeat(5000);
    set_url_guard_fetch(async () =>
      new Response(payload, { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const result = await executor.execute("http_request", {
      url: "https://example.com/data",
      max_chars: 100,
    });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.output.includes("ZZZZ")).toBe(true);
    expect(result.output.length).toBeLessThan(payload.length);
  });

  it("web_search clamps the HTML body before parsing", async () => {
    const work = await make_temp_dir();
    const executor = make_executor(work);
    const html = [
      "<html><body>",
      '<a class="result__a" href="https://example.com">Example</a>',
      "x".repeat(1000),
      "</body></html>",
    ].join("");
    globalThis.fetch = (async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
    const result = await executor.execute("web_search", { query: "example" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Example");
  });
});
