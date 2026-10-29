/**
 * register_listed: MCP names that sanitize to the same registered name keep
 * the first tool and warn instead of dropping the second silently (#133).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { register_listed } from "../src/mcp/mcp_register.js";
import type { McpSession } from "../src/mcp/mcp_session.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { logger } from "../src/util/log.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const session = { call_tool: async (name: string) => `called ${name}` } as unknown as McpSession;
const parameters = { type: "object", properties: {} } as const;

describe("register_listed", () => {
  it("keeps the first tool when two names sanitize to the same registered name, and warns", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const registry = new ToolRegistry();
    register_listed(
      registry,
      "editor",
      [
        { name: "open-file", description: "first", parameters },
        { name: "open_file", description: "second", parameters },
      ],
      "all",
      session,
    );
    expect(registry.list().map((tool) => tool.name)).toEqual(["mcp_editor_open_file"]);
    const tool = registry.get("mcp_editor_open_file");
    expect(tool?.description).toBe("first");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("editor/open_file");
  });

  it("registers only the allowlisted mcp name and does not call an aborted tool", async () => {
    const call_tool = vi.fn(async () => "called");
    const session = { call_tool } as unknown as McpSession;
    const registry = new ToolRegistry();
    register_listed(
      registry,
      "lab",
      [
        { name: "ping", description: "ping", parameters },
        { name: "exec", description: "exec", parameters },
      ],
      ["mcp_lab_ping"],
      session,
    );
    expect(registry.list().map((tool) => tool.name)).toEqual(["mcp_lab_ping"]);
    const controller = new AbortController();
    controller.abort();
    const result = await registry.get("mcp_lab_ping")?.execute({}, { work_dir: "/tmp", env: {}, signal: controller.signal });
    expect(result).toEqual({ ok: false, output: "", error: "cancelled" });
    expect(call_tool).not.toHaveBeenCalled();
  });
});
