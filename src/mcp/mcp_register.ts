import type { AgentConfig } from "../agent/config.js";
import { capture_errors } from "../tools/guard.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { Tool, ToolContext } from "../tools/types.js";
import { mcp_tool_name } from "./mcp_names.js";
import { pin_for } from "./mcp_pin.js";
import type { ListedTool } from "./mcp_result.js";
import type { McpSession } from "./mcp_session.js";

function name_allowed(enabled: AgentConfig["tools_enabled"], name: string): boolean {
  if (enabled === "all") {
    return true;
  }
  return enabled.includes(name);
}

function run_call(
  session: McpSession,
  wire_name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<{ ok: boolean; output: string; error?: string }> {
  return capture_errors(async () => {
    if (context.signal?.aborted === true) {
      throw new Error("cancelled");
    }
    return { ok: true, output: await session.call_tool(wire_name, args, context.signal) };
  });
}

function tool_for(registered: string, wire_name: string, spec: ListedTool, session: McpSession): Tool {
  return {
    name: registered,
    description: spec.description,
    parameters: spec.parameters,
    timeout_ms: 120000,
    execute: (args, context) => run_call(session, wire_name, args, context),
  };
}

export function register_listed(
  registry: ToolRegistry,
  server: string,
  listed: readonly ListedTool[],
  enabled: AgentConfig["tools_enabled"],
  session: McpSession,
  command?: string,
): void {
  const excluded = new Set(pin_for(server, command)?.exclude_tools ?? []);
  for (const spec of listed) {
    if (excluded.has(spec.name) === true) {
      continue;
    }
    const registered = mcp_tool_name(server, spec.name);
    if (name_allowed(enabled, registered) === false || registry.has(registered) === true) {
      continue;
    }
    registry.register(tool_for(registered, spec.name, spec, session));
  }
}
