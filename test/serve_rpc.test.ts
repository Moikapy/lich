/**
 * JSON-RPC framing for lich serve. Bad frames must fail closed and must not
 * touch the session store.
 */
import { describe, expect, it } from "vitest";
import { SERVE_ERROR_CODES } from "../src/serve/protocol.js";
import type { ServePromptService } from "../src/serve/prompts.js";
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
    pin: () => note("pin"),
    unpin: () => note("unpin"),
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

    const bool_id = await dispatch(
      JSON.stringify({
        jsonrpc: "2.0",
        id: true,
        method: "prompt.submit",
        params: { session_id: "s1", text: "hi" },
      }),
    );
    expect(bool_id.calls).toEqual([]);
    expect(bool_id.body).toEqual(
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
      { jsonrpc: "2.0", id: 8, method: "session.resume", params: { id: "abc", source: 1 } },
      { jsonrpc: "2.0", id: 9, method: "session.resume", params: { source: "tui" } },
      { jsonrpc: "2.0", id: 10, method: "session.create", params: { source: 1 } },
      { jsonrpc: "2.0", id: 11, method: "session.create", params: { source: "ok", label: 1 } },
      { jsonrpc: "2.0", id: 12, method: "health", params: [] },
      { jsonrpc: "2.0", id: 13, method: "session.list", params: [] },
    ];
    for (const frame of cases) {
      const result = await dispatch(JSON.stringify(frame));
      expect(result.calls).toEqual([]);
      expect(result.body).toEqual(
        rpc_error(frame.id, SERVE_ERROR_CODES.INVALID_PARAMS, "Invalid params"),
      );
    }
  });

  it("treats omitted, null, and empty object params as a list or health call", async () => {
    const frames = [
      { jsonrpc: "2.0", id: 1, method: "session.list" },
      { jsonrpc: "2.0", id: 2, method: "session.list", params: null },
      { jsonrpc: "2.0", id: 3, method: "session.list", params: {} },
    ];
    for (const frame of frames) {
      const listed = await dispatch(JSON.stringify(frame));
      expect(listed.calls).toEqual(["list"]);
      expect(listed.body).toMatchObject({
        error: { code: SERVE_ERROR_CODES.APPLICATION_ERROR },
      });
    }
    const empty_health = await dispatch(
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "health", params: {} }),
    );
    expect(empty_health.calls).toEqual([]);
    expect(empty_health.body).toMatchObject({ result: { status: "ok", protocol_version: 1 } });

    for (const params of ["x", 0]) {
      for (const method of ["health", "session.list"]) {
        const rejected = await dispatch(JSON.stringify({ jsonrpc: "2.0", id: 5, method, params }));
        expect(rejected.calls).toEqual([]);
        expect(rejected.body).toEqual(
          rpc_error(5, SERVE_ERROR_CODES.INVALID_PARAMS, "Invalid params"),
        );
      }
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

  it("rejects malformed prompt params without calling the agent", async () => {
    const calls: string[] = [];
    const prompts: ServePromptService = {
      submit: async () => {
        calls.push("submit");
        throw new Error("submit");
      },
      abort: () => {
        calls.push("abort");
        throw new Error("abort");
      },
      abort_all: () => undefined,
    };
    const { store } = untouched_store();
    const frames = [
      { id: 1, method: "prompt.submit", params: { session_id: "s" } },
      { id: 2, method: "prompt.submit", params: { text: "hi" } },
      { id: 3, method: "prompt.submit", params: { session_id: "", text: "hi" } },
      { id: 4, method: "prompt.submit", params: { session_id: "s", text: 1 } },
      { id: 5, method: "prompt.submit", params: [] },
      { id: 6, method: "prompt.submit", params: null },
      { id: 7, method: "prompt.abort", params: {} },
      { id: 8, method: "prompt.abort", params: { session_id: "" } },
      { id: 9, method: "prompt.abort", params: { session_id: 1 } },
      { id: 10, method: "prompt.abort", params: null },
    ];
    for (const frame of frames) {
      const text = await handle_serve_rpc_message(JSON.stringify({ jsonrpc: "2.0", ...frame }), {
        version: "9.9.9",
        sessions: store,
        prompts,
      });
      expect(JSON.parse(text ?? "")).toEqual(
        rpc_error(frame.id, SERVE_ERROR_CODES.INVALID_PARAMS, "Invalid params"),
      );
    }
    expect(calls).toEqual([]);
  });

  it("claims a prepared controller only for the submit it was armed for", async () => {
    const seen: Array<AbortController | undefined> = [];
    let claimed = 0;
    const controller = new AbortController();
    const prompts: ServePromptService = {
      submit: async (params, _notify, prepared) => {
        seen.push(prepared);
        return {
          session_id: params.session_id,
          reply: "ok",
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          session_path: undefined,
          turns_used: 0,
          stopped_reason: "final",
        };
      },
      abort: () => {
        throw new Error("abort");
      },
      abort_all: () => undefined,
    };
    const { store } = untouched_store();
    const frame = {
      jsonrpc: "2.0",
      id: 1,
      method: "prompt.submit",
      params: { session_id: "live", text: "hi" },
    };
    const mismatched = await handle_serve_rpc_message(JSON.stringify(frame), {
      version: "9.9.9",
      sessions: store,
      prompts,
      prepared_submit: { session_id: "other", controller },
      claim_prepared_submit: () => {
        claimed += 1;
      },
    });
    expect(claimed).toBe(0);
    expect(seen).toEqual([undefined]);
    expect(JSON.parse(mismatched ?? "")).toMatchObject({ result: { session_id: "live" } });

    const matched = await handle_serve_rpc_message(JSON.stringify({ ...frame, id: 2 }), {
      version: "9.9.9",
      sessions: store,
      prompts,
      prepared_submit: { session_id: "live", controller },
      claim_prepared_submit: () => {
        claimed += 1;
      },
    });
    expect(claimed).toBe(1);
    expect(seen[1]).toBe(controller);
    expect(JSON.parse(matched ?? "")).toMatchObject({ result: { session_id: "live" } });
  });
});
