/**
 * Serve session RPC: create / clear / list / resume with isolated history bags.
 */
import { mkdir, mkdtemp, rm, stat, unlink, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve_session_path } from "../src/session/resolve.js";
import { handle_serve_rpc_message, type ServeRpcContext } from "../src/serve/rpc.js";
import { create_serve_session_store } from "../src/serve/sessions.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

/**
 * When armed, `read_session_messages` throws ENOENT so a test can pin the
 * serve read-path branch (transcript vanishing between resolve and read)
 * without racing real filesystem interleaving. Off → real reader.
 */
const read_spy = vi.hoisted(() => ({ fail_read_enoent: false }));

vi.mock("../src/session/store.js", async (import_original) => {
  const actual = await import_original<typeof import("../src/session/store.js")>();
  return {
    ...actual,
    read_session_messages: (file_path: string) => {
      if (read_spy.fail_read_enoent === true) {
        return Promise.reject(
          Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
        );
      }
      return actual.read_session_messages(file_path);
    },
  };
});

const created: string[] = [];

async function make_temp_dir(prefix: string): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(path.join(TMP_BASE, `${prefix}-`));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function rpc_context(session_dir: string, max_bags?: number): ServeRpcContext {
  return { version: "9.9.9", sessions: create_serve_session_store(session_dir, max_bags) };
}

async function rpc(
  context: ServeRpcContext,
  method: string,
  params?: unknown,
  id: number = 1,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { jsonrpc: "2.0", id, method };
  if (params !== undefined) {
    body.params = params;
  }
  const raw = await handle_serve_rpc_message(JSON.stringify(body), context);
  return JSON.parse(raw ?? "") as Record<string, unknown>;
}

async function write_transcript(dir: string, id: string, messages: unknown[]): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file_path = path.join(dir, `${id}.jsonl`);
  const lines = messages.map((message) =>
    JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", kind: "message", message }),
  );
  await writeFile(file_path, `${lines.join("\n")}\n`, "utf8");
  return file_path;
}

describe("serve session rpc", () => {
  it("creates a session with a SessionHandle and empty history", async () => {
    const session_dir = path.join(await make_temp_dir("serve-create"), "sessions");
    const context = rpc_context(session_dir);
    const response = await rpc(context, "session.create", { source: "ossuary", label: "demo" });
    const result = response.result as { session_id: string };
    expect(result.session_id.length).toBeGreaterThan(0);
    const bag = context.sessions.get(result.session_id);
    expect(bag?.history).toEqual([]);
    expect(bag?.source).toBe("ossuary");
    expect(bag?.handle.id).toBe(result.session_id);
  });

  it("creates the transcript eagerly so session.list sees it before any append", async () => {
    const session_dir = path.join(await make_temp_dir("serve-create-visible"), "sessions");
    const context = rpc_context(session_dir);
    const response = await rpc(context, "session.create", { source: "ossuary" });
    const session_id = (response.result as { session_id: string }).session_id;

    const info = await stat(path.join(session_dir, `${session_id}.jsonl`));
    expect(info.isFile()).toBe(true);

    const listed = await rpc(context, "session.list", {});
    const ids = (listed.result as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id);
    expect(ids).toContain(session_id);
  });

  it("isolates history per session_id and clear resets only that bag", async () => {
    const session_dir = path.join(await make_temp_dir("serve-clear"), "sessions");
    await write_transcript(session_dir, "alpha-1", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
    await write_transcript(session_dir, "beta-1", [
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ]);
    const context = rpc_context(session_dir);
    const a = (await rpc(context, "session.resume", { id: "alpha-1" }, 1)).result as {
      session_id: string;
      message_count: number;
    };
    const b = (await rpc(context, "session.resume", { id: "beta-1" }, 2)).result as {
      session_id: string;
      message_count: number;
    };
    expect(a.message_count).toBe(2);
    expect(b.message_count).toBe(2);
    expect(a.session_id).not.toBe(b.session_id);
    expect(context.sessions.get(a.session_id)?.history).toHaveLength(2);
    expect(context.sessions.get(b.session_id)?.history).toHaveLength(2);

    const cleared = await rpc(context, "session.clear", { session_id: a.session_id }, 3);
    expect(cleared.result).toEqual({ session_id: a.session_id });
    expect(context.sessions.get(a.session_id)?.history).toEqual([]);
    expect(context.sessions.get(b.session_id)?.history).toHaveLength(2);
  });

  it("lists transcripts under session_dir by mtime", async () => {
    const session_dir = path.join(await make_temp_dir("serve-list"), "sessions");
    await write_transcript(session_dir, "old-1", [{ role: "user", content: "x" }, { role: "assistant", content: "y" }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await write_transcript(session_dir, "new-1", [{ role: "user", content: "z" }, { role: "assistant", content: "w" }]);
    const context = rpc_context(session_dir);
    const response = await rpc(context, "session.list", {});
    const result = response.result as { sessions: Array<{ id: string; mtime_ms: number }> };
    expect(result.sessions.map((entry) => entry.id)).toEqual(["new-1", "old-1"]);
    expect(result.sessions[0]!.mtime_ms).toBeGreaterThanOrEqual(result.sessions[1]!.mtime_ms);
  });

  it("resumes via resolve_session_path and seeds message_count", async () => {
    const session_dir = path.join(await make_temp_dir("serve-resume"), "sessions");
    await write_transcript(session_dir, "m1abc-1-tui", [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    const resolved = await resolve_session_path(session_dir, "m1abc");
    expect(path.basename(resolved, ".jsonl")).toBe("m1abc-1-tui");

    const context = rpc_context(session_dir);
    const response = await rpc(context, "session.resume", { id: "m1abc" });
    const result = response.result as { session_id: string; resumed_id: string; message_count: number };
    expect(result.message_count).toBe(3);
    expect(result.resumed_id).toBe("m1abc-1-tui");
    expect(context.sessions.get(result.session_id)?.history).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it("resumes with a custom source tag and reports resumed_id", async () => {
    const session_dir = path.join(await make_temp_dir("serve-resume-source"), "sessions");
    await write_transcript(session_dir, "src-1", [{ role: "user", content: "x" }]);
    const context = rpc_context(session_dir);
    const response = await rpc(context, "session.resume", { id: "src-1", source: "ossuary" });
    const result = response.result as { session_id: string; resumed_id: string; message_count: number };
    expect(result.resumed_id).toBe("src-1");
    expect(context.sessions.get(result.session_id)?.source).toBe("ossuary");
  });

  it("resumes a just-created empty transcript (fork id lists immediately, message_count 0)", async () => {
    const session_dir = path.join(await make_temp_dir("serve-resume-empty"), "sessions");
    const context = rpc_context(session_dir);
    const created = await rpc(context, "session.create", { source: "ossuary" });
    const original_id = (created.result as { session_id: string }).session_id;

    const response = await rpc(context, "session.resume", { id: original_id });
    const result = response.result as { session_id: string; resumed_id: string; message_count: number };
    expect(response.error).toBeUndefined();
    expect(result.message_count).toBe(0);
    expect(result.resumed_id).toBe(original_id);
    expect(result.session_id).not.toBe(original_id);

    const info = await stat(path.join(session_dir, `${result.session_id}.jsonl`));
    expect(info.isFile()).toBe(true);
    const listed = await rpc(context, "session.list", {});
    const ids = (listed.result as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id);
    expect(ids).toContain(result.session_id);
  });

  it("rejects resume of a transcript deleted after create with not_found, not an empty success", async () => {
    const session_dir = path.join(await make_temp_dir("serve-resume-deleted"), "sessions");
    const context = rpc_context(session_dir);
    const created = await rpc(context, "session.create", { source: "ossuary" });
    const session_id = (created.result as { session_id: string }).session_id;
    await unlink(path.join(session_dir, `${session_id}.jsonl`));

    const response = await rpc(context, "session.resume", { id: session_id });
    expect(response.error).toMatchObject({ code: -32000, message: "session not found" });
  });

  it("maps a transcript vanishing between resolve and read to not_found (read-path ENOENT)", async () => {
    const session_dir = path.join(await make_temp_dir("serve-resume-raced"), "sessions");
    await write_transcript(session_dir, "raced-1", [
      { role: "user", content: "x" },
      { role: "assistant", content: "y" },
    ]);
    const context = rpc_context(session_dir);
    read_spy.fail_read_enoent = true;
    try {
      const response = await rpc(context, "session.resume", { id: "raced-1" });
      expect(response.error).toMatchObject({ code: -32000, message: "session not found" });
    } finally {
      read_spy.fail_read_enoent = false;
    }
  });

  it("rejects prompt.submit without an agent (-32000)", async () => {
    const session_dir = path.join(await make_temp_dir("serve-prompt"), "sessions");
    const context = rpc_context(session_dir);
    const response = await rpc(context, "prompt.submit", { session_id: "x", text: "hi" });
    expect(response.error).toMatchObject({ code: -32000, message: /agent not configured/ });
  });

  it("rejects create without source and clear of unknown id", async () => {
    const session_dir = path.join(await make_temp_dir("serve-params"), "sessions");
    const context = rpc_context(session_dir);
    const bad_create = await rpc(context, "session.create", { label: "x" });
    expect(bad_create.error).toMatchObject({ code: -32602 });
    const bad_clear = await rpc(context, "session.clear", { session_id: "missing" });
    expect(bad_clear.error).toMatchObject({ code: -32000, message: /session not found/ });
  });

  it("rejects empty-string labels on create (empty source also invalid)", async () => {
    const session_dir = path.join(await make_temp_dir("serve-label"), "sessions");
    const context = rpc_context(session_dir);
    const bad = await rpc(context, "session.create", { source: "x", label: "" });
    expect(bad.error).toMatchObject({ code: -32602 });
    const ok = await rpc(context, "session.create", { source: "x" });
    expect(ok.result).toHaveProperty("session_id");
  });

  it("evicts the least recently used bag beyond the cap", async () => {
    const session_dir = path.join(await make_temp_dir("serve-lru"), "sessions");
    const context = rpc_context(session_dir, 2);
    const first = (await rpc(context, "session.create", { source: "a" })).result as {
      session_id: string;
    };
    const second = (await rpc(context, "session.create", { source: "b" })).result as {
      session_id: string;
    };
    // Touch `first` so `second` becomes the LRU entry.
    context.sessions.get(first.session_id);
    const third = (await rpc(context, "session.create", { source: "c" })).result as {
      session_id: string;
    };
    expect(context.sessions.get(first.session_id)).toBeDefined();
    expect(context.sessions.get(second.session_id)).toBeUndefined();
    expect(context.sessions.get(third.session_id)).toBeDefined();
  });

  it("dispose drops every bag", async () => {
    const session_dir = path.join(await make_temp_dir("serve-dispose"), "sessions");
    const context = rpc_context(session_dir);
    const first = (await rpc(context, "session.create", { source: "a" })).result as {
      session_id: string;
    };
    context.sessions.dispose();
    expect(context.sessions.get(first.session_id)).toBeUndefined();
  });

  it("rejects resume of a missing id with a clean -32000", async () => {
    const session_dir = path.join(await make_temp_dir("serve-resume-missing"), "sessions");
    const context = rpc_context(session_dir);
    const response = await rpc(context, "session.resume", { id: "no-such-id" });
    expect(response.error).toMatchObject({ code: -32000, message: "session not found" });
  });

  it("rejects ambiguous prefix resume with a clean -32000", async () => {
    const session_dir = path.join(await make_temp_dir("serve-resume-amb"), "sessions");
    await write_transcript(session_dir, "dup-1", [{ role: "user", content: "x" }]);
    await write_transcript(session_dir, "dup-2", [{ role: "user", content: "y" }]);
    const context = rpc_context(session_dir);
    const response = await rpc(context, "session.resume", { id: "dup" });
    expect(response.error).toMatchObject({ code: -32000, message: "ambiguous session id" });
  });

  it("keeps traversal-shaped ids inside session_dir (path-safety pin)", async () => {
    const session_dir = path.join(await make_temp_dir("serve-traversal"), "sessions");
    const outside = path.dirname(session_dir);
    const secret = path.join(outside, "secret.jsonl");
    await mkdir(outside, { recursive: true });
    await writeFile(secret, "stolen", "utf8");
    const context = rpc_context(session_dir);
    const response = await rpc(context, "session.resume", { id: "../secret" });
    expect(response.error).toMatchObject({ code: -32000, message: "session not found" });
  });

  it("resumes meta/malformed records with only valid messages", async () => {
    const session_dir = path.join(await make_temp_dir("serve-resume-filter"), "sessions");
    await mkdir(session_dir, { recursive: true });
    const lines = [
      JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", kind: "meta", meta: { note: "skip me" } }),
      JSON.stringify({ ts: "2026-01-01T00:00:01.000Z", kind: "message", message: { role: "user", content: "hi" } }),
      "not json at all",
      JSON.stringify({ ts: "2026-01-01T00:00:02.000Z", kind: "message", message: { role: "assistant", content: "yo" } }),
    ];
    await writeFile(path.join(session_dir, "mixed-1.jsonl"), `${lines.join("\n")}\n`, "utf8");
    const context = rpc_context(session_dir);
    const response = await rpc(context, "session.resume", { id: "mixed-1" });
    const result = response.result as { resumed_id: string; message_count: number };
    expect(result.message_count).toBe(2);
    expect(result.resumed_id).toBe("mixed-1");
  });

  it("writes filtered bag history into the resume fork (drops trailing user, matches bag)", async () => {
    const session_dir = path.join(await make_temp_dir("serve-fork-filtered"), "sessions");
    await write_transcript(session_dir, "src-conv-1", [
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "dangling" },
    ]);
    const context = rpc_context(session_dir);
    const fork = (await rpc(context, "session.resume", { id: "src-conv-1" })).result as {
      session_id: string;
      message_count: number;
    };
    // read_session_messages drops the trailing user; bag and fork must agree.
    expect(fork.message_count).toBe(2);
    expect(context.sessions.get(fork.session_id)?.history).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
    ]);
    const fork_raw = await readFile(path.join(session_dir, `${fork.session_id}.jsonl`), "utf8");
    expect(fork_raw).toContain("question");
    expect(fork_raw).toContain("answer");
    expect(fork_raw).not.toContain("dangling");

    // A later `latest` resume reloads the filtered history, not an empty file.
    const latest = (await rpc(context, "session.resume", { id: "latest" }, 2)).result as {
      message_count: number;
      resumed_id: string;
    };
    expect(latest.resumed_id).toBe(fork.session_id);
    expect(latest.message_count).toBe(2);
  });

  it("keeps message_count stable across repeated fork resumes (several trailing users)", async () => {
    const session_dir = path.join(await make_temp_dir("serve-fork-stable"), "sessions");
    await write_transcript(session_dir, "stacked-1", [
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "dangling-1" },
      { role: "user", content: "dangling-2" },
    ]);
    const context = rpc_context(session_dir);
    const first = (await rpc(context, "session.resume", { id: "stacked-1" })).result as {
      session_id: string;
      message_count: number;
    };
    expect(first.message_count).toBe(2);
    const second = (await rpc(context, "session.resume", { id: first.session_id }, 2)).result as {
      session_id: string;
      message_count: number;
    };
    expect(second.message_count).toBe(2);
    const third = (await rpc(context, "session.resume", { id: second.session_id }, 3)).result as {
      message_count: number;
    };
    expect(third.message_count).toBe(2);
    expect(context.sessions.get(second.session_id)?.history).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
    ]);
  });

  it("marks the resume fork handle seeded so recorder.seed does not re-append history", async () => {
    const session_dir = path.join(await make_temp_dir("serve-fork-seeded"), "sessions");
    await write_transcript(session_dir, "seeded-1", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    const context = rpc_context(session_dir);
    const fork = (await rpc(context, "session.resume", { id: "seeded-1" })).result as {
      session_id: string;
    };
    const bag = context.sessions.get(fork.session_id);
    expect(bag).toBeDefined();
    const { create_session_recorder } = await import("../src/session/recorder.js");
    const recorder = create_session_recorder(bag!.handle);
    await recorder.seed({
      input: "next turn",
      history: bag!.history,
      system_prompt: undefined,
      owned: false,
    });
    await recorder.flush();
    const raw = await readFile(bag!.handle.path, "utf8");
    // History appears once (from the fork write); only the new user turn is
    // appended. A double-seed would leave two "hello" / "hi" pairs.
    expect(raw.match(/"content":"hello"/g)).toHaveLength(1);
    expect(raw.match(/"content":"hi"/g)).toHaveLength(1);
    expect(raw).toContain("next turn");
  });
});

describe("resolve_session_path package export", () => {
  it("is importable from the public entry for consumers", async () => {
    const { resolve_session_path: exported } = await import("../src/index.js");
    expect(typeof exported).toBe("function");
  });
});
