/**
 * JSON-RPC framing for lich serve. Bad frames must fail closed and must not
 * touch the session store.
 */
import { describe, expect, it } from "vitest";
import { SERVE_ERROR_CODES } from "../src/serve/protocol.js";
import { handle_serve_rpc_message, type ServeRpcContext } from "../src/serve/rpc.js";
import type { ServeSessionStore } from "../src/serve/sessions.js";

function untouched_store(): { store: ServeSessionStore; calls: string[] } {
  const calls: string[] = [];
  const note = (name: string): never => {
    calls.push(name);
    throw new Error(`session store called: ${name}`);
  };
  const store: ServeSessionStore = {
    create: async () => note("create"),
    clear: () => note("clear"),
    list: async () => note("list"),
    resume: async () => note("resume"),
    get: () => note("get"),
    dispose: () => {
      calls.push("dispose");
    },
  };
  return { store, calls };
}

async function dispatch(raw: string): Promise<{ body: unknown; calls: string[] }> {
  const { store, calls } = untouched_store();
  const context: ServeRpcContext = { version: "9.9.9", sessions: store };
  const text = await handle_serve_rpc_message(raw, context);
  const body = text === undefined ? undefined : JSON.parse(text);
  return { body, calls };
}

function rpc_error(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

describe("serve rpc framing", () => {
  it("rejects unparseable, batch, and non-object frames", async () => {
    const parse_error = await dispatch("{");
    expect(parse_error.calls).toEqual([]);
    expect(parse_error.body).toEqual(
      rpc_error(null, SERVE_ERROR_CODES.PARSE_ERROR, "Parse error"),
    );

    const batch = await dispatch(
      JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "health" }]),
    );
    expect(batch.calls).toEqual([]);
    expect(batch.body).toEqual(
      rpc_error(null, SERVE_ERROR_CODES.INVALID_REQUEST, "Batch requests are not supported"),
    );

    const null_frame = await dispatch("null");
    expect(null_frame.body).toEqual(
      rpc_error(null, SERVE_ERROR_CODES.INVALID_REQUEST, "Invalid Request"),
    );
    const number_frame = await dispatch("42");
    expect(number_frame.body).toEqual(
      rpc_error(null, SERVE_ERROR_CODES.INVALID_REQUEST, "Invalid Request"),
    );
    expect(number_frame.calls).toEqual([]);
  });

  it("rejects a bad envelope and ignores notifications", async () => {
    const wrong_version = await dispatch(
      JSON.stringify({ jsonrpc: "2.1", id: "req-1", method: "health" }),
    );
    expect(wrong_version.calls).toEqual([]);
    expect(wrong_version.body).toEqual(
      rpc_error("req-1", SERVE_ERROR_CODES.INVALID_REQUEST, "Invalid Request"),
    );

    const bad_method = await dispatch(
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: 1 }),
    );
    expect(bad_method.body).toEqual(
      rpc_error(4, SERVE_ERROR_CODES.INVALID_REQUEST, "Invalid Request"),
    );

    const bad_id = await dispatch(
      JSON.stringify({ jsonrpc: "2.0", id: { n: 1 }, method: "health" }),
    );
    expect(bad_id.body).toEqual(
      rpc_error(null, SERVE_ERROR_CODES.INVALID_REQUEST, "Invalid Request"),
    );

    const notification = await dispatch(
      JSON.stringify({ jsonrpc: "2.0", method: "session.clear", params: { session_id: "s1" } }),
    );
    expect(notification.body).toBeUndefined();
    expect(notification.calls).toEqual([]);
  });

  it("reports an unknown method and does not touch sessions", async () => {
    const unknown = await dispatch(
      JSON.stringify({ jsonrpc: "2.0", id: 8, method: "session.delete", params: {} }),
    );
    expect(unknown.calls).toEqual([]);
    expect(unknown.body).toEqual(
      rpc_error(8, SERVE_ERROR_CODES.METHOD_NOT_FOUND, "Method not found: session.delete"),
    );
  });

  it("rejects invalid params for health, list, create, clear, and resume", async () => {
    const cases = [
      { jsonrpc: "2.0", id: 1, method: "health", params: { verbose: true } },
      { jsonrpc: "2.0", id: 2, method: "session.list", params: { id: "x" } },
      { jsonrpc: "2.0", id: 3, method: "session.create", params: [] },
      { jsonrpc: "2.0", id: 4, method: "session.clear", params: { session_id: "" } },
      { jsonrpc: "2.0", id: 5, method: "session.clear", params: { session_id: 1 } },
      { jsonrpc: "2.0", id: 6, method: "session.resume", params: { id: "abc", source: "" } },
      { jsonrpc: "2.0", id: 7, method: "session.resume", params: { id: "" } },
    ];
    for (const frame of cases) {
      const result = await dispatch(JSON.stringify(frame));
      expect(result.calls).toEqual([]);
      expect(result.body).toEqual(
        rpc_error(frame.id, SERVE_ERROR_CODES.INVALID_PARAMS, "Invalid params"),
      );
    }
  });

  it("answers health for a null id and for empty params", async () => {
    const null_id = await dispatch(JSON.stringify({ jsonrpc: "2.0", id: null, method: "health" }));
    expect(null_id.calls).toEqual([]);
    expect(null_id.body).toEqual({
      jsonrpc: "2.0",
      id: null,
      result: expect.objectContaining({ status: "ok", version: "9.9.9" }),
    });

    const null_params = await dispatch(
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "health", params: null }),
    );
    expect(null_params.calls).toEqual([]);
    expect(null_params.body).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: expect.objectContaining({ status: "ok", version: "9.9.9" }),
    });
  });

  it("rejects prompt calls when no agent is configured", async () => {
    const abort = await dispatch(
      JSON.stringify({ jsonrpc: "2.0", id: 9, method: "prompt.abort", params: { session_id: "s1" } }),
    );
    expect(abort.calls).toEqual([]);
    expect(abort.body).toEqual(
      rpc_error(9, SERVE_ERROR_CODES.APPLICATION_ERROR, "agent not configured"),
    );

    const submit = await dispatch(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "submit-1",
        method: "prompt.submit",
        params: { session_id: "s1", text: "hi" },
      }),
    );
    expect(submit.calls).toEqual([]);
    expect(submit.body).toEqual(
      rpc_error("submit-1", SERVE_ERROR_CODES.APPLICATION_ERROR, "agent not configured"),
    );
  });
});
