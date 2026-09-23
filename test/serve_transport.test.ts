/**
 * Serve transport tests: loopback WS JSON-RPC, health, and token rejection.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import WebSocket from "ws";
import { LICH_VERSION } from "../src/index.js";
import { handle_serve_rpc_message } from "../src/serve/rpc.js";
import { create_serve_server, type ServeServer } from "../src/serve/server.js";

const servers: ServeServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await server?.stop();
  }
});

describe("serve rpc health", () => {
  it("returns status and version for health", () => {
    const raw = handle_serve_rpc_message(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "health", params: {} }),
      "9.9.9",
    );
    expect(JSON.parse(raw ?? "")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { status: "ok", version: "9.9.9" },
    });
  });

  it("returns method-not-found for session.create until later issues", () => {
    const raw = handle_serve_rpc_message(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "session.create",
        params: { source: "test" },
      }),
      "9.9.9",
    );
    const body = JSON.parse(raw ?? "") as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32601);
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
});

async function rpc_over_ws(
  port: number,
  token: string | null,
  request: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<unknown> {
  const url =
    token === null ? `ws://127.0.0.1:${port}/` : `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
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
