import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import dns from "node:dns/promises";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { register_builtin_tools } from "../src/tools/builtin/index.js";
import { TMP_BASE } from "./helpers/tmp_base.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { is_blocked_ip, reset_url_guard_fetch, set_url_guard_fetch } from "../src/tools/url_guard.js";

let tmp_root: string;
let executor: ToolExecutor;

function fake_response(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const status = init.status ?? 200;
  return new Response(body, { status, headers: init.headers ?? {} });
}

const real_fetch: typeof fetch = globalThis.fetch;

/** Assign mock_fn as the global fetch; restore_fetch() undoes it. */
function stub_fetch(mock_fn: typeof fetch): void {
  globalThis.fetch = mock_fn as typeof fetch;
}

/** Restore the real global fetch captured before any stubbing. */
function restore_fetch(): void {
  globalThis.fetch = real_fetch;
}

const MARKER_NAME = "lich_pl_test_marker_7f3d";

interface MarkerProcess {
  name: string;
  child: ChildProcess;
}

/** Spawn a uniquely-named sleeper so process_list filtering is deterministic. */
async function spawn_marker_process(): Promise<MarkerProcess> {
  const child = spawn("bash", ["-c", `exec -a ${MARKER_NAME} sleep 60`], { stdio: "ignore" });
  await new Promise<void>((resolve) => {
    child.on("spawn", () => resolve());
    child.on("error", () => resolve());
  });
  return { name: MARKER_NAME, child };
}

async function write_temp(relative: string, content: string | Buffer): Promise<void> {
  const target = path.join(tmp_root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
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
    await remove_quiet(file);
  }
  for (let index = dirs.length - 1; index >= 0; index -= 1) {
    const dir = dirs[index];
    if (dir !== undefined) {
      await remove_quiet(dir);
    }
  }
}

async function remove_quiet(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch {
    try {
      await rmdir(target);
    } catch {
      // best-effort cleanup only
    }
  }
}

const DDG_HTML = [
  "<html><body>",
  '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen&amp;rut=abc">Node.js &amp; More</a>',
  '<a class="result__a" href="https://github.com/nodejs/node">nodejs/node &#x27;repo&#x27;</a>',
  "</body></html>",
].join("\n");

beforeAll(async () => {
  await mkdir(TMP_BASE, { recursive: true });
  tmp_root = await mkdtemp(path.join(TMP_BASE, "tools-extra-"));
  const registry = new ToolRegistry();
  register_builtin_tools(registry);
  executor = new ToolExecutor(registry, { work_dir: tmp_root, env: {} });
});

beforeEach(() => {
  process.env.LICH_TEST_SECRET_1 = "hush-hush";
  process.env.LICH_TEST_PLAIN = "plain-value";
  vi.spyOn(dns, "lookup").mockImplementation(async (_hostname: string, options?: unknown) => {
    if (typeof options === "object" && options !== null && (options as { all?: boolean }).all === true) {
      return [{ address: "93.184.216.34", family: 4 }] as never;
    }
    return { address: "93.184.216.34", family: 4 } as never;
  });
});

afterEach(() => {
  restore_fetch();
  vi.restoreAllMocks();
  delete process.env.LICH_TEST_SECRET_1;
  delete process.env.LICH_TEST_PLAIN;
});

afterAll(async () => {
  await iter_rm(tmp_root);
});

describe("fetch_url", () => {
  it("returns status header, html marker, and clamped body", async () => {
    stub_fetch(vi.fn(async () =>
      fake_response("<html><body>hello world</body></html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
    ));
    const result = await executor.execute("fetch_url", { url: "https://example.com/page", max_chars: 5000 });
    expect(result.ok).toBe(true);
    expect(result.output.startsWith("# 200 text/html; charset=utf-8 (")).toBe(true);
    expect(result.output.includes("[html content]")).toBe(true);
    expect(result.output.includes("hello world")).toBe(true);
  });

  it("maps non-2xx to http_<status> error", async () => {
    stub_fetch(vi.fn(async () => fake_response("nope", { status: 404, headers: { "content-type": "text/plain" } })));
    const result = await executor.execute("fetch_url", { url: "https://example.com/missing" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("http_404");
  });

  it("rejects image and octet-stream content types", async () => {
    stub_fetch(
      vi.fn(async () => fake_response("bytes", { headers: { "content-type": "image/png" } })),
    );
    const image = await executor.execute("fetch_url", { url: "https://example.com/pic.png" });
    expect(image.error).toBe("unsupported_content_type: image/png");
    stub_fetch(
      vi.fn(async () => fake_response("bytes", { headers: { "content-type": "application/octet-stream" } })),
    );
    const binary = await executor.execute("fetch_url", { url: "https://example.com/blob" });
    expect(binary.error).toBe("unsupported_content_type: application/octet-stream");
  });

  it("rejects invalid urls and non-http protocols", async () => {
    const malformed = await executor.execute("fetch_url", { url: "not a url" });
    expect(malformed.ok).toBe(false);
    expect(malformed.error?.startsWith("invalid_url")).toBe(true);
    const ftp = await executor.execute("fetch_url", { url: "ftp://example.com/file" });
    expect(ftp.ok).toBe(false);
    expect(ftp.error?.startsWith("invalid_url")).toBe(true);
    const file_scheme = await executor.execute("fetch_url", { url: "file:///etc/passwd" });
    expect(file_scheme.ok).toBe(false);
    expect(file_scheme.error?.startsWith("invalid_url")).toBe(true);
  });

  it("converts fetch failures into ok:false with a message", async () => {
    stub_fetch(vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 93.184.216.34:1");
    }));
    const result = await executor.execute("fetch_url", { url: "https://example.com:1/x" });
    expect(result.ok).toBe(false);
    expect(result.error?.includes("ECONNREFUSED")).toBe(true);
  });

  it("blocks loopback, link-local, and private URLs before fetch", async () => {
    const fetch_mock = vi.fn(async () => fake_response("nope"));
    stub_fetch(fetch_mock);
    for (const url of ["http://127.0.0.1/", "http://169.254.169.254/latest", "http://10.0.0.1/", "http://[::1]/"]) {
      const result = await executor.execute("fetch_url", { url });
      expect(result.ok).toBe(false);
      expect(result.error?.startsWith("blocked_url")).toBe(true);
    }
    expect(fetch_mock).not.toHaveBeenCalled();
    expect(is_blocked_ip("192.168.1.1")).toBe(true);
    expect(is_blocked_ip("8.8.8.8")).toBe(false);
  });

  it("revalidates redirect hops and refuses a private Location", async () => {
    const fetch_mock = vi.fn(async () =>
      fake_response("", { status: 302, headers: { location: "http://127.0.0.1/secret", "content-type": "text/plain" } }),
    );
    stub_fetch(fetch_mock);
    const result = await executor.execute("fetch_url", { url: "https://example.com/start" });
    expect(result.ok).toBe(false);
    expect(result.error?.startsWith("blocked_url")).toBe(true);
    expect(fetch_mock).toHaveBeenCalledTimes(1);
  });
});

describe("web_search", () => {
  it("parses results, unwraps ddg redirects, and decodes entities", async () => {
    stub_fetch(vi.fn(async () => fake_response(DDG_HTML, { headers: { "content-type": "text/html" } })));
    const result = await executor.execute("web_search", { query: "nodejs official site" });
    expect(result.ok).toBe(true);
    expect(result.output.includes("1. Node.js & More")).toBe(true);
    expect(result.output.includes("   https://nodejs.org/en")).toBe(true);
    expect(result.output.includes("2. nodejs/node 'repo'")).toBe(true);
    expect(result.output.includes("duckduckgo.com/l/")).toBe(false);
  });

  it("reports no results for empty html", async () => {
    stub_fetch(vi.fn(async () => fake_response("<html><body>nothing here</body></html>")));
    const result = await executor.execute("web_search", { query: "zero match query" });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("no results");
  });

  it("wraps http failures as search_failed", async () => {
    stub_fetch(vi.fn(async () => fake_response("robot", { status: 403, headers: { "content-type": "text/plain" } })));
    const denied = await executor.execute("web_search", { query: "anything" });
    expect(denied.ok).toBe(false);
    expect(denied.error).toBe("search_failed: http_403");
    stub_fetch(vi.fn(async () => {
      throw new Error("network down");
    }));
    const thrown = await executor.execute("web_search", { query: "anything" });
    expect(thrown.ok).toBe(false);
    expect(thrown.error?.startsWith("search_failed:")).toBe(true);
  });
});

describe("http_request", () => {
  it("passes method, headers, and body through; renders status/content-type/body", async () => {
    const fetch_mock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      fake_response('{"ok":true}', { headers: { "content-type": "application/json", "ratelimit-remaining": "59" } }),
    );
    stub_fetch(fetch_mock);
    const result = await executor.execute("http_request", {
      url: "https://api.example.com/v1/items",
      method: "post",
      headers: { "content-type": "application/json", "x-token": "abc" },
      body: '{"name":"test"}',
    });
    expect(result.ok).toBe(true);
    const call = fetch_mock.mock.calls[0] as unknown as [string, RequestInit] | undefined;
    expect(call !== undefined).toBe(true);
    const init = call?.[1];
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(init?.body).toBe('{"name":"test"}');
    expect(result.output.includes("# status 200")).toBe(true);
    expect(result.output.includes("# content-type application/json")).toBe(true);
    expect(result.output.includes("# header ratelimit-remaining: 59")).toBe(true);
    expect(result.output.includes('{"ok":true}')).toBe(true);
  });

  it("sends no body for GET and rejects invalid methods", async () => {
    const fetch_mock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => fake_response("fine"));
    stub_fetch(fetch_mock);
    const result = await executor.execute("http_request", { url: "https://api.example.com/ping", method: "GET", body: "ignored" });
    expect(result.ok).toBe(true);
    const call = fetch_mock.mock.calls[0] as unknown as [string, RequestInit] | undefined;
    expect(call !== undefined).toBe(true);
    const init = call?.[1];
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    const bad = await executor.execute("http_request", { url: "https://api.example.com/ping", method: "TRACE" });
    expect(bad.ok).toBe(false);
    expect(bad.error?.startsWith("invalid_method")).toBe(true);
  });
});

describe("process_list", () => {
  it("lists real processes and honors the filter", async () => {
    const listing = await executor.execute("process_list", {});
    expect(listing.ok).toBe(true);
    const lines = listing.output.split("\n");
    expect(lines.length > 1).toBe(true);
    expect(lines[0]?.includes("\t")).toBe(true);
    const filtered = await executor.execute("process_list", { filter: "no_such_filter_xyz" });
    expect(filtered.ok).toBe(true);
    expect(filtered.output).toBe("no matching processes");
    const marker = await spawn_marker_process();
    try {
      const marker_filter = await executor.execute("process_list", { filter: marker.name });
      expect(marker_filter.ok).toBe(true);
      expect(marker_filter.output.includes(marker.name)).toBe(true);
    } finally {
      marker.child.kill("SIGKILL");
    }
  });
});

describe("disk_usage", () => {
  it("sorts du sizes descending with a total and blocks path escapes", async () => {
    await write_temp("du/small.txt", "x");
    await write_temp("du/big.txt", "y".repeat(1024));
    const result = await executor.execute("disk_usage", { path: "du" });
    expect(result.ok).toBe(true);
    const lines = result.output.split("\n");
    const total_line = lines[lines.length - 1] ?? "";
    expect(total_line.startsWith("TOTAL\t")).toBe(true);
    const big_index = result.output.indexOf("big.txt");
    const small_index = result.output.indexOf("small.txt");
    expect(big_index >= 0 && small_index > big_index).toBe(true);
    const escape = await executor.execute("disk_usage", { path: "../../etc" });
    expect(escape.ok).toBe(false);
    expect(escape.error?.startsWith("path_escape")).toBe(true);
  });
});

describe("env_get", () => {
  it("masks values unless revealed and always redacts secret-ish names", async () => {
    const hidden = await executor.execute("env_get", { keys: ["LICH_TEST_SECRET_1"] });
    expect(hidden.ok).toBe(true);
    expect(hidden.output).toBe("LICH_TEST_SECRET_1=set (9 chars)");
    const revealed = await executor.execute("env_get", { keys: ["LICH_TEST_SECRET_1"], reveal: true });
    expect(revealed.output).toBe("LICH_TEST_SECRET_1=<redacted: 9 chars>");
    const plain = await executor.execute("env_get", { keys: ["LICH_TEST_PLAIN"], reveal: true });
    expect(plain.output).toBe("LICH_TEST_PLAIN=plain-value");
  });

  it("lists names only by default and supports prefix and unset keys", async () => {
    const names = await executor.execute("env_get", {});
    expect(names.ok).toBe(true);
    expect(names.output.includes("LICH_TEST_PLAIN")).toBe(true);
    expect(names.output.includes("plain-value")).toBe(false);
    const prefix = await executor.execute("env_get", { prefix: "LICH_TEST_" });
    expect(prefix.ok).toBe(true);
    expect(prefix.output.includes("LICH_TEST_PLAIN=set")).toBe(true);
    const unset = await executor.execute("env_get", { keys: ["LICH_TEST_ABSENT_XYZ"] });
    expect(unset.output).toBe("LICH_TEST_ABSENT_XYZ=<unset>");
  });

  it("never leaks secret values even when revealed", async () => {
    const direct = await executor.execute("env_get", { keys: ["LICH_TEST_SECRET_1"], reveal: true });
    expect(direct.ok).toBe(true);
    expect(direct.output.includes("hush-hush")).toBe(false);
  });
});