import type { AgentConfig } from "../agent/config.js";
import { logger } from "../util/log.js";
import { http_pipe } from "./mcp_http.js";
import { plan_stdio } from "./mcp_plan.js";
import { stdio_pipe } from "./mcp_pipe.js";
import { register_listed } from "./mcp_register.js";
import { McpSession } from "./mcp_session.js";
import { default_line_spawner } from "./mcp_stdio.js";
import type { McpRuntime } from "./mcp_tools.js";
import type { ToolRegistry } from "../tools/registry.js";

async function open_and_register(
  registry: ToolRegistry,
  name: string,
  enabled: AgentConfig["tools_enabled"],
  session: McpSession,
): Promise<McpSession | undefined> {
  try {
    register_listed(registry, name, await session.list_tools(), enabled, session);
    return session;
  } catch (error) {
    session.close();
    const message = error instanceof Error ? error.message : "mcp skipped";
    logger.warn(`mcp ${name} skipped: ${message}`);
    return undefined;
  }
}

export async function attach_stdio(
  registry: ToolRegistry,
  name: string,
  entry: { command: string; args: readonly string[]; env?: Record<string, string> },
  config: AgentConfig,
  runtime: McpRuntime | undefined,
): Promise<McpSession | undefined> {
  const planned = plan_stdio(name, entry.command, entry.args, runtime?.env_path ?? process.env.PATH);
  if (typeof planned === "string") {
    logger.warn(`mcp ${name} skipped: ${planned}`);
    return undefined;
  }
  const spawn = runtime?.spawn ?? default_line_spawner;
  const session = new McpSession(stdio_pipe(spawn(planned.command, planned.args, entry.env)));
  return open_and_register(registry, name, config.tools_enabled, session);
}

export async function attach_http(
  registry: ToolRegistry,
  name: string,
  url: string,
  config: AgentConfig,
  runtime: McpRuntime | undefined,
): Promise<McpSession | undefined> {
  const session = new McpSession(http_pipe(url, runtime?.fetch_fn ?? fetch));
  return open_and_register(registry, name, config.tools_enabled, session);
}
