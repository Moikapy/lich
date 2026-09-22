/**
 * Serve session RPC: create / clear / list / resume with isolated history bags.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolve_session_path } from "../src/session/resolve.js";
import { handle_serve_rpc_message, type ServeRpcContext } from "../src/serve/rpc.js";
import { create_serve_session_store } from "../src/serve/sessions.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

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

function rpc_context(session_dir: string): ServeRpcContext {
  return { version: "9.9.9", sessions: create_serve_session_store(session_dir) };
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
    const result = response.result as { session_id: string; message_count: number };
    expect(result.message_count).toBe(3);
    expect(context.sessions.get(result.session_id)?.history).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it("keeps prompt.submit unimplemented (-32601)", async () => {
    const session_dir = path.join(await make_temp_dir("serve-prompt"), "sessions");
    const context = rpc_context(session_dir);
    const response = await rpc(context, "prompt.submit", { session_id: "x", text: "hi" });
    expect(response.error).toMatchObject({ code: -32601 });
  });

  it("rejects create without source and clear of unknown id", async () => {
    const session_dir = path.join(await make_temp_dir("serve-params"), "sessions");
    const context = rpc_context(session_dir);
    const bad_create = await rpc(context, "session.create", { label: "x" });
    expect(bad_create.error).toMatchObject({ code: -32602 });
    const bad_clear = await rpc(context, "session.clear", { session_id: "missing" });
    expect(bad_clear.error).toMatchObject({ code: -32000, message: /session not found/ });
  });
});

describe("resolve_session_path package export", () => {
  it("is importable from the public entry for consumers", async () => {
    const { resolve_session_path: exported } = await import("../src/index.js");
    expect(typeof exported).toBe("function");
  });
});
