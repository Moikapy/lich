import { describe, expect, expectTypeOf, it } from "vitest";
import type { AgentEvent } from "../src/agent/events.js";
import {
  SERVE_METHODS,
  SERVE_ERROR_CODES,
  SERVE_NOTIFICATION_EVENT,
  type JsonRpcRequest,
  type ServeEventNotification,
  type ServeMethod,
  type ServeMethodMap,
  type ServeRequest,
} from "../src/serve/protocol.js";

describe("serve protocol types", () => {
  it("locks the serve method names", () => {
    expect([...SERVE_METHODS]).toEqual([
      "health",
      "session.create",
      "session.list",
      "session.clear",
      "prompt.submit",
      "prompt.abort",
    ]);
  });

  it("locks the serve error codes to JSON-RPC 2.0 values", () => {
    expect(SERVE_ERROR_CODES).toEqual({
      PARSE_ERROR: -32700,
      INVALID_REQUEST: -32600,
      METHOD_NOT_FOUND: -32601,
      INVALID_PARAMS: -32602,
      APPLICATION_ERROR: -32000,
      INTERNAL_ERROR: -32603,
    });
  });

  it("types a health request and event notification", () => {
    const request: ServeRequest<"health"> = {
      jsonrpc: "2.0",
      id: 1,
      method: "health",
      params: {},
    };
    const event: AgentEvent = { type: "turn_start", turn: 1 };
    const notification: ServeEventNotification = {
      jsonrpc: "2.0",
      method: SERVE_NOTIFICATION_EVENT,
      params: { session_id: "abc", event },
    };

    expect(request.method).toBe("health");
    expect(notification.params.event.type).toBe("turn_start");
  });

  it("covers every ServeMethod in ServeMethodMap", () => {
    const sample: { [M in ServeMethod]: ServeMethodMap[M]["params"] } = {
      health: {},
      "session.create": { source: "ossuary", label: "demo" },
      "session.list": {},
      "session.clear": { session_id: "s1" },
      "prompt.submit": { session_id: "s1", text: "hi" },
      "prompt.abort": { session_id: "s1" },
    };
    expect(Object.keys(sample).sort()).toEqual([...SERVE_METHODS].sort());
  });

  it("requires params on ServeRequest while JsonRpcRequest may omit them", () => {
    type BareSubmit = {
      jsonrpc: "2.0";
      id: 1;
      method: "prompt.submit";
    };
    type BareClear = {
      jsonrpc: "2.0";
      id: 2;
      method: "session.clear";
    };
    type BareAbort = {
      jsonrpc: "2.0";
      id: 3;
      method: "prompt.abort";
    };

    expectTypeOf<BareSubmit>().toMatchTypeOf<
      JsonRpcRequest<"prompt.submit", ServeMethodMap["prompt.submit"]["params"]>
    >();
    expectTypeOf<BareSubmit>().not.toMatchTypeOf<ServeRequest<"prompt.submit">>();
    expectTypeOf<BareClear>().not.toMatchTypeOf<ServeRequest<"session.clear">>();
    expectTypeOf<BareAbort>().not.toMatchTypeOf<ServeRequest<"prompt.abort">>();

    // @ts-expect-error ServeRequest requires params for prompt.submit
    const missing_submit: ServeRequest<"prompt.submit"> = {
      jsonrpc: "2.0",
      id: 1,
      method: "prompt.submit",
    };
    // @ts-expect-error ServeRequest requires params for session.clear
    const missing_clear: ServeRequest<"session.clear"> = {
      jsonrpc: "2.0",
      id: 2,
      method: "session.clear",
    };
    // @ts-expect-error ServeRequest requires params for prompt.abort
    const missing_abort: ServeRequest<"prompt.abort"> = {
      jsonrpc: "2.0",
      id: 3,
      method: "prompt.abort",
    };

    void missing_submit;
    void missing_clear;
    void missing_abort;

    const with_params: ServeRequest<"prompt.submit"> = {
      jsonrpc: "2.0",
      id: 4,
      method: "prompt.submit",
      params: { session_id: "s1", text: "hi" },
    };
    expect(with_params.params.session_id).toBe("s1");
  });

  it("ties method to params on the bare ServeRequest union", () => {
    // @ts-expect-error prompt.submit params require session_id and text
    const mismatched: ServeRequest = {
      jsonrpc: "2.0",
      id: 5,
      method: "prompt.submit",
      params: {},
    };
    void mismatched;

    const text_of = (r: ServeRequest): string | undefined =>
      r.method === "prompt.submit" ? r.params.text : undefined;
    expect(
      text_of({
        jsonrpc: "2.0",
        id: 6,
        method: "prompt.submit",
        params: { session_id: "s1", text: "hi" },
      }),
    ).toBe("hi");

    const method_of = <M extends ServeMethod>(r: ServeRequest<M>): M => r.method;
    expect(
      method_of({ jsonrpc: "2.0", id: 7, method: "health", params: {} }),
    ).toBe("health");
  });
});
