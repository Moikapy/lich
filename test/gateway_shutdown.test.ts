/**
 * Gateway shutdown (G-10): adapters are stopped and awaited (bounded by a
 * timeout) before the bus and agent are released.
 */
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../src/agent/agent.js";
import type { GatewayBus } from "../src/gateway/bus.js";
import { shutdown_gateway } from "../src/gateway/runner.js";
import type { PlatformAdapter } from "../src/gateway/types.js";
import { logger } from "../src/util/log.js";

function tracked(order: string[]): { agent: Agent; bus: GatewayBus } {
  return {
    agent: { close: () => order.push("agent.close") } as unknown as Agent,
    bus: { stop: () => order.push("bus.stop") } as unknown as GatewayBus,
  };
}

describe("shutdown_gateway", () => {
  it("waits for every adapter to stop before releasing the bus and agent", async () => {
    const order: string[] = [];
    const { agent, bus } = tracked(order);
    const slow: PlatformAdapter = {
      name: "slow",
      capabilities: { kind: "text" },
      start: async () => undefined,
      stop: () => new Promise((resolve) => setTimeout(() => resolve(order.push("slow.stop") as unknown as void), 20)),
    };
    const broken: PlatformAdapter = {
      name: "broken",
      capabilities: { kind: "text" },
      start: async () => undefined,
      stop: async () => {
        throw new Error("socket gone");
      },
    };
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await shutdown_gateway(agent, bus, [slow, broken]);
    expect(order).toEqual(["slow.stop", "bus.stop", "agent.close"]);
    vi.restoreAllMocks();
  });

  it("stops waiting after the timeout when an adapter hangs", async () => {
    const order: string[] = [];
    const { agent, bus } = tracked(order);
    const hung: PlatformAdapter = { name: "hung", capabilities: { kind: "text" }, start: async () => undefined, stop: () => new Promise(() => undefined) };
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await shutdown_gateway(agent, bus, [hung], 20);
    expect(order).toEqual(["bus.stop", "agent.close"]);
    expect(String(warn.mock.calls[0]?.[0])).toContain("did not stop within 20ms");
    vi.restoreAllMocks();
  });
});
