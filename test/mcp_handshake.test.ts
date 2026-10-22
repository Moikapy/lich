/**
 * MCP initialize must accept a real handshake, and a rejected one must close
 * the pipe before notifications/initialized.
 */
import { describe, expect, it } from "vitest";
import { init_params } from "../src/mcp/mcp_handshake.js";
import { McpSession, type McpPipe } from "../src/mcp/mcp_session.js";

interface Script {
  pipe: McpPipe;
  methods: string[];
  closed: number;
  initialize_params: unknown;
}

function script_pipe(initialize: unknown | Error, tools_list?: unknown | Error): Script {
  const methods: string[] = [];
  const state = { closed: 0, initialize_params: undefined as unknown };
  const pipe: McpPipe = {
    request: async (method, params) => {
      methods.push(`request:${method}`);
      if (method === "initialize") {
        state.initialize_params = params;
        if (initialize instanceof Error) {
          throw initialize;
        }
        return initialize;
      }
      if (method === "tools/list") {
        if (tools_list instanceof Error) {
          throw tools_list;
        }
        return tools_list ?? { tools: [] };
      }
      if (method === "tools/call") {
        return { content: [{ type: "text", text: "ok" }] };
      }
      throw new Error(`unexpected ${method}`);
    },
    notify: (method) => {
      methods.push(`notify:${method}`);
    },
    close: () => {
      state.closed += 1;
      methods.push("close");
    },
  };
  return {
    pipe,
    methods,
    get closed() {
      return state.closed;
    },
    get initialize_params() {
      return state.initialize_params;
    },
  };
}

const ok_handshake = { protocolVersion: "2024-11-05", serverInfo: { name: "lab" } };

describe("mcp session handshake", () => {
  it("initializes once, notifies, and then lists and calls", async () => {
    const script = script_pipe(ok_handshake);
    const session = new McpSession(script.pipe);
    expect(await session.list_tools()).toEqual([]);
    expect(await session.list_tools()).toEqual([]);
    expect(await session.call_tool("ping", { n: 1 })).toBe("ok");
    expect(script.initialize_params).toEqual(init_params());
    expect(script.methods.filter((method) => method === "request:initialize")).toEqual(["request:initialize"]);
    expect(script.methods).toContain("notify:notifications/initialized");
    expect(script.closed).toBe(0);
    session.close();
    session.close();
    expect(script.closed).toBe(1);
  });

  it("closes and does not notify when initialize is rejected", async () => {
    const rejected: unknown[] = [
      null,
      {},
      { protocolVersion: "" },
      { protocolVersion: "2024-11-05" },
      { protocolVersion: "2024-11-05", serverInfo: { name: "" } },
      { protocolVersion: "2024-11-05", serverInfo: { name: 1 } },
      new Error("socket closed"),
    ];
    for (const initialize of rejected) {
      const script = script_pipe(initialize);
      const session = new McpSession(script.pipe);
      await expect(session.list_tools()).rejects.toThrow(/mcp handshake rejected|socket closed/);
      expect(script.methods).not.toContain("notify:notifications/initialized");
      expect(script.closed).toBe(1);
      expect(script.methods).not.toContain("request:tools/list");
    }
  });

  it("stays open when tools/list fails after a valid handshake", async () => {
    const script = script_pipe(ok_handshake, new Error("list down"));
    const session = new McpSession(script.pipe);
    await expect(session.list_tools()).rejects.toThrow("list down");
    expect(script.methods).toContain("notify:notifications/initialized");
    expect(script.closed).toBe(0);
  });
});
