/**
 * Fan-out for AgentEmitter / EnvelopedAgentEmitter. A throwing subscriber
 * must not drop later handlers, and emit snapshots the set so unsubscribe
 * and subscribe during delivery cannot skip or join the current event.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentEmitter, EnvelopedAgentEmitter, type AgentEvent, type AgentEventBody } from "../src/agent/events.js";

const body: AgentEventBody = { type: "turn_end", turn: 2 };

const enveloped: AgentEvent = {
  type: "run_end",
  stopped_reason: "final",
  turns_used: 1,
  run_id: "run-1",
  session_id: "sess-1",
  seq: 3,
  ts: 1,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent event emitters", () => {
  it("still delivers to later handlers when an earlier one throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const emitter = new AgentEmitter();
    const seen: string[] = [];
    emitter.on(() => {
      throw new Error("subscriber failed");
    });
    emitter.on(() => {
      seen.push("kept");
    });
    emitter.emit(body);
    expect(seen).toEqual(["kept"]);
  });

  it("keeps the current snapshot when a handler unsubscribes the next one", () => {
    const emitter = new EnvelopedAgentEmitter();
    const seen: string[] = [];
    let stop_second: (() => void) | undefined;
    emitter.on(() => {
      seen.push("first");
      stop_second?.();
    });
    stop_second = emitter.on(() => {
      seen.push("second");
    });
    emitter.emit(enveloped);
    expect(seen).toEqual(["first", "second"]);
    emitter.emit(enveloped);
    expect(seen).toEqual(["first", "second", "first"]);
  });

  it("does not call a handler that subscribed during the current emit", () => {
    const emitter = new AgentEmitter();
    const seen: string[] = [];
    let added = false;
    emitter.on(() => {
      seen.push("first");
      if (added === true) {
        return;
      }
      added = true;
      emitter.on(() => {
        seen.push("added");
      });
    });
    emitter.emit(body);
    expect(seen).toEqual(["first"]);
    emitter.emit(body);
    expect(seen).toEqual(["first", "first", "added"]);
  });
});
