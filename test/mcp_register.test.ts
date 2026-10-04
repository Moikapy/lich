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
});
