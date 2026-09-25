import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewaySession } from "./gateway-session.js";

type SocketListener = (event: { data?: string }) => void;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  private readonly listeners = new Map<string, Set<SocketListener>>();

  constructor(readonly url: string) {
    sockets.push(this);
  }

  addEventListener(type: string, fn: SocketListener): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  fail(): void {
    this.emit("error");
  }

  receive(data: string): void {
    this.emit("message", data);
  }

  private emit(type: string, data?: string): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ data });
    }
  }
}

const sockets: FakeWebSocket[] = [];

function last_socket(): FakeWebSocket {
  const socket = sockets.at(-1);
  if (socket === undefined) {
    throw new Error("expected a websocket");
  }
  return socket;
}

async function connected_session(): Promise<{ session: GatewaySession; socket: FakeWebSocket }> {
  const session = new GatewaySession();
  const pending = session.connect("ws://127.0.0.1:9/", 9);
  const socket = last_socket();
  socket.open();
  await pending;
  return { session, socket };
}

describe("GatewaySession", () => {
  beforeEach(() => {
    sockets.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("connects and reports a copied status", async () => {
    const { session, socket } = await connected_session();
    expect(socket.url).toBe("ws://127.0.0.1:9/");
    expect(session.get_info()).toEqual({ status: "connected", port: 9 });
  });

  it("rejects connect on socket error", async () => {
    const session = new GatewaySession();
    const pending = session.connect("ws://127.0.0.1:9/", 9);
    last_socket().fail();
    await expect(pending).rejects.toThrow("gateway websocket error");
    expect(session.get_info()).toEqual({ status: "error", port: 9, error: "websocket error" });
  });

  it("rejects connect when the socket does not open", async () => {
    vi.useFakeTimers();
    const session = new GatewaySession();
    const pending = session.connect("ws://127.0.0.1:9/", 9);
    const assertion = expect(pending).rejects.toThrow("gateway websocket connect timeout");
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(session.get_info()).toEqual({ status: "connecting", port: 9 });
  });

  it("refuses requests until the socket is open", async () => {
    const session = new GatewaySession();
    await expect(session.request("health")).rejects.toThrow("gateway not connected");
  });

  it("correlates in-flight responses by id, including out of order", async () => {
    const { session, socket } = await connected_session();
    const first = session.request("session.list");
    const second = session.request("prompt.abort", { session_id: "s1" });
    expect(socket.sent.map((raw) => JSON.parse(raw))).toEqual([
      { jsonrpc: "2.0", id: 1, method: "session.list", params: {} },
      { jsonrpc: "2.0", id: 2, method: "prompt.abort", params: { session_id: "s1" } },
    ]);
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { aborted: true } }));
    socket.receive("not-json");
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 99, result: { status: "nope" } }));
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessions: [] } }));
    await expect(second).resolves.toEqual({ aborted: true });
    await expect(first).resolves.toEqual({ sessions: [] });
  });

  it("rejects rpc errors and uses a stable fallback when message is not a string", async () => {
    const { session, socket } = await connected_session();
    const named = session.request("prompt.submit", { session_id: "s", text: "hi" });
    socket.receive(JSON.stringify({ id: 1, error: { message: "agent not configured" } }));
    await expect(named).rejects.toThrow("agent not configured");

    const bare = session.request("health");
    socket.receive(JSON.stringify({ id: 2, error: { message: 12 } }));
    await expect(bare).rejects.toThrow("rpc error");
  });

  it("fans out notifications and stops after unsubscribe", async () => {
    const { session, socket } = await connected_session();
    const seen: Array<[string, unknown]> = [];
    const stop = session.subscribe((method, params) => {
      seen.push([method, params]);
    });
    socket.receive(JSON.stringify({ method: "event", params: { session_id: "abc" } }));
    stop();
    socket.receive(JSON.stringify({ method: "event", params: { session_id: "later" } }));
    expect(seen).toEqual([["event", { session_id: "abc" }]]);
  });

  it("rejects in-flight requests when the session or socket closes", async () => {
    const local = await connected_session();
    const closed_locally = local.session.request("health");
    local.session.close();
    await expect(closed_locally).rejects.toThrow("gateway closed");
    expect(local.session.get_info()).toEqual({ status: "stopped", port: 9 });
    await expect(local.session.request("health")).rejects.toThrow("gateway not connected");

    const remote = await connected_session();
    const closed_remotely = remote.session.request("session.list");
    remote.socket.close();
    await expect(closed_remotely).rejects.toThrow("gateway websocket closed");
    expect(remote.session.get_info()).toEqual({ status: "stopped", port: 9 });
  });
});
