/**
 * Loopback MCP HTTP pipe: JSON-RPC POST, no extra headers, redirect errors.
 * Uses an injected fetch — never opens a socket.
 */
import { describe, expect, it, vi } from "vitest";
import { http_pipe } from "../src/mcp/mcp_http.js";

const LOOPBACK = "http://127.0.0.1:9/mcp";

describe("mcp http pipe", () => {
  it("posts json-rpc with only content headers and maps error bodies", async () => {
    const calls: RequestInit[] = [];
    const fetch_fn = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      const body = JSON.parse(String(init?.body)) as { method?: string };
      if (body.method === "tools/call") {
        return new Response(JSON.stringify({ error: { message: "nope" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: { tools: [] } }), { status: 200 });
    }) as typeof fetch;
    const pipe = http_pipe(LOOPBACK, fetch_fn);
    await expect(pipe.request("tools/list", {})).resolves.toEqual({ tools: [] });
    await expect(pipe.request("tools/call", { name: "x" })).rejects.toThrow("nope");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.redirect).toBe("error");
    expect(calls[0]?.headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
    });
    expect(JSON.parse(String(calls[0]?.body))).toMatchObject({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(JSON.parse(String(calls[1]?.body))).toMatchObject({ jsonrpc: "2.0", id: 2, method: "tools/call" });
    pipe.close();
  });

  it("uses a generic mcp error when the body omits a message", async () => {
    const fetch_fn = (async () => new Response(JSON.stringify({ error: {} }))) as typeof fetch;
    const pipe = http_pipe(LOOPBACK, fetch_fn);
    await expect(pipe.request("ping", {})).rejects.toThrow("mcp error");
  });

  it("rejects an already-aborted request before fetch", async () => {
    const fetch_fn = vi.fn(async () => new Response("{}")) as typeof fetch;
    const pipe = http_pipe(LOOPBACK, fetch_fn);
    const controller = new AbortController();
    controller.abort();
    await expect(pipe.request("ping", {}, controller.signal)).rejects.toThrow("cancelled");
    expect(fetch_fn).not.toHaveBeenCalled();
  });

  it("swallows notify failures and sends no request id", async () => {
    const bodies: string[] = [];
    const redirects: Array<RequestInit["redirect"]> = [];
    const fetch_fn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      redirects.push(init?.redirect);
      throw new Error("down");
    }) as typeof fetch;
    const pipe = http_pipe(LOOPBACK, fetch_fn);
    expect(() => pipe.notify("notifications/initialized")).not.toThrow();
    await vi.waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(JSON.parse(bodies[0] ?? "")).toEqual({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(redirects).toEqual(["error"]);
  });
});
