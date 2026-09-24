import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fetch_health, request_gateway, subscribe_notifications } from "./gateway-client";

describe("gateway-client", () => {
  const requestGateway = vi.fn();
  const onNotification = vi.fn();

  beforeEach(() => {
    requestGateway.mockReset();
    onNotification.mockReset();
    (globalThis as { window: Window }).window = {
      ossuary: {
        ready: true,
        getConnectionInfo: vi.fn(),
        requestGateway,
        onConnection: vi.fn(() => () => undefined),
        onNotification,
      },
    } as unknown as Window;
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
  });

  it("request_gateway forwards method and params", async () => {
    requestGateway.mockResolvedValue({ ok: true });
    await expect(request_gateway("health", {})).resolves.toEqual({ ok: true });
    expect(requestGateway).toHaveBeenCalledWith("health", {});
  });

  it("fetch_health validates result shape", async () => {
    requestGateway.mockResolvedValue({ status: "ok", version: "0.9.0" });
    await expect(fetch_health()).resolves.toEqual({ status: "ok", version: "0.9.0" });
    requestGateway.mockResolvedValue({ status: "nope" });
    await expect(fetch_health()).rejects.toThrow(/unexpected health/);
  });

  it("subscribe_notifications wires preload handler", () => {
    const unsub = vi.fn();
    onNotification.mockReturnValue(unsub);
    const handler = vi.fn();
    expect(subscribe_notifications(handler)).toBe(unsub);
    expect(onNotification).toHaveBeenCalledWith(handler);
  });
});
