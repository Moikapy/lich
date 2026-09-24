/**
 * Serve transport tests: loopback WS JSON-RPC, health, and token rejection.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect as net_connect } from "node:net";
import path from "node:path";
import { Writable } from "node:stream";
import WebSocket from "ws";
import { LICH_VERSION } from "../src/index.js";
import { handle_serve_rpc_message } from "../src/serve/rpc.js";
import { create_serve_server, type ServeServer } from "../src/serve/server.js";
import { create_serve_session_store } from "../src/serve/sessions.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

/**
 * File-wide spy on the session store: records create/dispose ordering and can
 * gate `create` so a test can hold an RPC handler mid-I/O while stop() runs.
 */
const serve_store_spy = vi.hoisted(() => {
  type ReleaseFn = () => void;
  const state = {
    events: [] as string[],
    gate: null as Promise<void> | null,
    release_gate: null as ReleaseFn | null,
    reset(): void {
      state.events.length = 0;
      state.gate = null;
      state.release_gate = null;
    },
    /** Clear recorded events and hold the next create until released. */
    arm(): void {
      state.reset();
      state.hold();
    },
    /** Hold the next (and later) creates until `release_gate` is called. */
    hold(): void {
      state.gate = new Promise<void>((resolve) => {
        state.release_gate = resolve;
      });
    },
  };
  return state;
});

vi.mock("../src/serve/sessions.js", async (import_original) => {
  const actual = await import_original<typeof import("../src/serve/sessions.js")>();
  const wrap_store = (store: ReturnType<typeof actual.create_serve_session_store>) => ({
    ...store,
    create: async (params: Parameters<typeof store.create>[0]) => {
      serve_store_spy.events.push("create_start");
      if (serve_store_spy.gate !== null) {
        await serve_store_spy.gate;
      }
      const result = await store.create(params);
      serve_store_spy.events.push("create_done");
      return result;
    },
    dispose: () => {
      serve_store_spy.events.push("dispose");
      store.dispose();
    },
  });
  return {
    ...actual,
    create_serve_session_store: (dir: string, max_bags?: number) =>
      wrap_store(actual.create_serve_session_store(dir, max_bags)),
  };
});

const servers: ServeServer[] = [];
const created: string[] = [];

async function make_temp_dir(prefix: string): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(path.join(TMP_BASE, `${prefix}-`));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  serve_store_spy.reset();
  while (servers.length > 0) {
    const server = servers.pop();
    await server?.stop();
  }
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("serve rpc health", () => {
  it("returns status and version for health", async () => {
    const sessions = create_serve_session_store(path.join(await make_temp_dir("serve-health"), "s"));
    const raw = await handle_serve_rpc_message(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "health", params: {} }),
      { version: "9.9.9", sessions },
    );
    expect(JSON.parse(raw ?? "")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { status: "ok", version: "9.9.9" },
    });
  });

  it("returns agent-not-configured for prompt.submit without an agent", async () => {
    const sessions = create_serve_session_store(path.join(await make_temp_dir("serve-stub"), "s"));
    const raw = await handle_serve_rpc_message(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "prompt.submit",
        params: { session_id: "s1", text: "hi" },
      }),
      { version: "9.9.9", sessions },
    );
    const body = JSON.parse(raw ?? "") as { error?: { code?: number; message?: string } };
    expect(body.error?.code).toBe(-32000);
    expect(body.error?.message).toMatch(/agent not configured/);
  });
});

describe("serve websocket transport", () => {
  it("boots on port 0, emits boot JSON, and answers health", async () => {
    const boots: string[] = [];
    const boot_stdout = new Writable({
      write(chunk, _enc, cb) {
        boots.push(String(chunk));
        cb();
      },
    });
    const server = create_serve_server({ port: 0, boot_stdout, version: LICH_VERSION });
    servers.push(server);
    const boot = await server.start();
    expect(boot.port).toBeGreaterThan(0);
    expect(boot.token.length).toBeGreaterThan(8);
    expect(JSON.parse(boots.join("").trim())).toEqual({ port: boot.port, token: boot.token });

    const result = await rpc_over_ws(boot.port, boot.token, {
      jsonrpc: "2.0",
      id: 1,
      method: "health",
      params: {},
    });
    expect(result).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { status: "ok", version: LICH_VERSION },
    });
  });

  it("accepts ::1 clients when bound to IPv6 loopback", async () => {
    const server = create_serve_server({ host: "::1", port: 0, boot_stdout: null });
    servers.push(server);
    const boot = await server.start();
    const result = await rpc_over_ws(
      boot.port,
      boot.token,
      { jsonrpc: "2.0", id: 3, method: "health", params: {} },
      undefined,
      "::1",
    );
    expect(result).toMatchObject({
      id: 3,
      result: { status: "ok", version: expect.any(String) },
    });
  });

  it("rejects connections without a token", async () => {
    const server = create_serve_server({ port: 0, boot_stdout: null, token: "secret-token-value" });
    servers.push(server);
    const boot = await server.start();
    await expect(open_ws(`ws://127.0.0.1:${boot.port}/`)).rejects.toThrow();
  });

  it("rejects connections with a bad token", async () => {
    const server = create_serve_server({ port: 0, boot_stdout: null, token: "secret-token-value" });
    servers.push(server);
    const boot = await server.start();
    await expect(open_ws(`ws://127.0.0.1:${boot.port}/?token=wrong-token-value`)).rejects.toThrow();
  });

  it("accepts token via x-lich-token header", async () => {
    const server = create_serve_server({ port: 0, boot_stdout: null, token: "header-token-value" });
    servers.push(server);
    const boot = await server.start();
    const result = await rpc_over_ws(
      boot.port,
      null,
      { jsonrpc: "2.0", id: 7, method: "health", params: {} },
      { "x-lich-token": boot.token },
    );
    expect(result).toMatchObject({
      id: 7,
      result: { status: "ok", version: expect.any(String) },
    });
  });

  it("refuses non-loopback hosts", () => {
    expect(() => create_serve_server({ host: "0.0.0.0", boot_stdout: null })).toThrow(/loopback/);
  });

  it("rejects upgrades with a non-loopback Host header", async () => {
    const server = create_serve_server({ port: 0, boot_stdout: null, token: "host-check-token" });
    servers.push(server);
    const boot = await server.start();
    await expect(
      open_ws(`ws://127.0.0.1:${boot.port}/?token=${encodeURIComponent(boot.token)}`, {
        Host: "evil.example",
      }),
    ).rejects.toThrow(/HTTP 403/);
  });

  it("retries start with EADDRINUSE after a listen failure, not already started", async () => {
    const holder = createServer();
    await new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.listen(0, "127.0.0.1", () => resolve());
    });
    const occupied = (holder.address() as { port: number }).port;
    try {
      const server = create_serve_server({ port: occupied, boot_stdout: null });
      servers.push(server);
      await expect(server.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
      await expect(server.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });

  it("releases the port when on_listening throws during start", async () => {
    let leaked_port = 0;
    const first = create_serve_server({
      port: 0,
      boot_stdout: null,
      on_listening: (info) => {
        leaked_port = info.port;
        throw new Error("on_listening boom");
      },
    });
    servers.push(first);
    await expect(first.start()).rejects.toThrow(/on_listening boom/);
    expect(leaked_port).toBeGreaterThan(0);
    await first.stop();

    const second = create_serve_server({ port: leaked_port, boot_stdout: null });
    servers.push(second);
    const boot = await second.start();
    expect(boot.port).toBe(leaked_port);
  });

  // Smoke test: RST on the pre-upgrade 401 path must not crash the server and
  // must not break later RPC. It does not assert which error listener handles
  // the write error — the sync write+destroy in the 401 branch usually masks
  // it, so on_socket_error in src/serve/server.ts stays defense-in-depth.
  it("survives TCP reset during pre-upgrade 401 response", async () => {
    const server = create_serve_server({
      port: 0,
      boot_stdout: null,
      token: "pre-upgrade-token",
    });
    servers.push(server);
    const boot = await server.start();

    const uncaught: Error[] = [];
    const on_uncaught = (error: Error) => {
      uncaught.push(error);
    };
    process.on("uncaughtException", on_uncaught);
    try {
      for (let i = 0; i < 5; i++) {
        await reset_during_pre_upgrade_401(boot.port);
      }
      // Give any deferred socket error a chance to surface as uncaught.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(uncaught).toEqual([]);

      const result = await rpc_over_ws(boot.port, boot.token, {
        jsonrpc: "2.0",
        id: 9,
        method: "health",
        params: {},
      });
      expect(result).toMatchObject({
        id: 9,
        result: { status: "ok", version: expect.any(String) },
      });

      await expect(server.stop()).resolves.toBeUndefined();
    } finally {
      process.off("uncaughtException", on_uncaught);
    }
  });

  it("round-trips session.create and session.resume over WS", async () => {
    const session_dir = path.join(await make_temp_dir("serve-ws-sessions"), "sessions");
    await mkdir(session_dir, { recursive: true });
    await writeFile(
      path.join(session_dir, "ws-demo-1.jsonl"),
      [
        JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", kind: "message", message: { role: "user", content: "hi" } }),
        JSON.stringify({ ts: "2026-01-01T00:00:01.000Z", kind: "message", message: { role: "assistant", content: "hello" } }),
      ].join("\n") + "\n",
      "utf8",
    );
    const server = create_serve_server({ port: 0, boot_stdout: null, session_dir });
    servers.push(server);
    const boot = await server.start();

    const created = await rpc_over_ws(boot.port, boot.token, {
      jsonrpc: "2.0",
      id: 1,
      method: "session.create",
      params: { source: "ossuary", label: "ws-demo" },
    });
    const session_id = (created as { result: { session_id: string } }).result.session_id;
    expect(session_id.length).toBeGreaterThan(0);

    const resumed = await rpc_over_ws(boot.port, boot.token, {
      jsonrpc: "2.0",
      id: 2,
      method: "session.resume",
      params: { id: "ws-demo-1" },
    });
    expect(resumed).toMatchObject({
      id: 2,
      result: { session_id: expect.any(String), resumed_id: "ws-demo-1", message_count: 2 },
    });
    // The server's store carries the resumed history for prompt.submit (#83).
    const bag = server.sessions.get(
      (resumed as { result: { session_id: string } }).result.session_id,
    );
    expect(bag?.history).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("drains a create held mid-I/O before stop() disposes the store", async () => {
    const session_dir = path.join(await make_temp_dir("serve-ws-drain"), "sessions");
    const server = create_serve_server({ port: 0, boot_stdout: null, session_dir });
    servers.push(server);
    const boot = await server.start();

    serve_store_spy.arm();
    const url = `ws://127.0.0.1:${boot.port}/?token=${encodeURIComponent(boot.token)}`;
    const ws = await open_ws(url);
    try {
      ws.send(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.create", params: { source: "ossuary" } }),
      );
      // Wait until the handler is parked inside create() before stopping.
      await vi.waitFor(() => {
        expect(serve_store_spy.events).toContain("create_start");
      });

      const stopped = server.stop();
      serve_store_spy.release_gate?.();
      await stopped;
      // The bag was put strictly before dispose dropped the store; the reply
      // itself may be lost to the concurrent close handshake (not asserted).
      expect(serve_store_spy.events).toEqual(["create_start", "create_done", "dispose"]);
    } finally {
      ws.close();
    }
  });

  it("replies to pipelined frames in order, per connection", async () => {
    const session_dir = path.join(await make_temp_dir("serve-ws-order"), "sessions");
    const server = create_serve_server({ port: 0, boot_stdout: null, session_dir });
    servers.push(server);
    const boot = await server.start();

    const url = `ws://127.0.0.1:${boot.port}/?token=${encodeURIComponent(boot.token)}`;
    const ws = await open_ws(url);
    try {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.list", params: {} }));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "health", params: {} }));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session.list", params: {} }));
      const ids: number[] = [];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("pipeline timeout")), 5000);
        ws.on("message", (data) => {
          ids.push((JSON.parse(String(data)) as { id: number }).id);
          if (ids.length === 3) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      expect(ids).toEqual([1, 2, 3]);
    } finally {
      ws.close();
    }
  });
});

async function rpc_over_ws(
  port: number,
  token: string | null,
  request: Record<string, unknown>,
  headers?: Record<string, string>,
  host: string = "127.0.0.1",
): Promise<unknown> {
  const authority = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
  const url =
    token === null ? `ws://${authority}/` : `ws://${authority}/?token=${encodeURIComponent(token)}`;
  const ws = await open_ws(url, headers);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("rpc timeout")), 5000);
      ws.once("message", (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(String(data)));
      });
      ws.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      ws.send(JSON.stringify(request));
    });
  } finally {
    ws.close();
  }
}

function open_ws(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, headers === undefined ? undefined : { headers });
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("websocket open timeout"));
    }, 5000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      res.resume();
      reject(new Error(`websocket open failed: HTTP ${res.statusCode}`));
    });
    ws.once("error", () => {
      clearTimeout(timer);
      reject(new Error("websocket open failed"));
    });
  });
}

/**
 * Raw TCP: complete the upgrade with a wrong token so the server writes 401
 * and never calls wss.handleUpgrade, then RST to race the 401 write. The
 * wrong token keeps the socket on the server's pre-upgrade path — a valid
 * token hands it to ws, which attaches its own socket error listener.
 *
 * Smoke-test scenario: the 401 branch's sync write+destroy usually masks
 * the write error, so this does not assert which error listener handles
 * it; on_socket_error in src/serve/server.ts is defense-in-depth and is
 * not directly exercised.
 */
function reset_during_pre_upgrade_401(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net_connect({ host: "127.0.0.1", port }, () => {
      socket.write(
        "GET /?token=wrong-token HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          "\r\n",
      );
      // RST to race the server's 401 write. on_socket_error in server.ts is
      // defense-in-depth for async write errors here; the sync write+destroy
      // usually masks the error, so no listener is asserted.
      socket.resetAndDestroy();
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("pre-upgrade 401 reset timeout"));
    }, 5000);
    socket.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.on("error", () => {
      // Expected after resetAndDestroy (ECONNRESET on the client side).
    });
  });
}
