import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/agent/events.js";
import {
  SERVE_METHODS,
  SERVE_NOTIFICATION_EVENT,
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
});
