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
): Promise<void> {
  try {
    register_listed(registry, name, await session.list_tools(), enabled, session);
  } catch (error) {
    session.close();
    const message = error instanceof Error ? error.message : "mcp skipped";
    logger.warn(`mcp ${name} skipped: ${message}`);
  }
}

export async function attach_stdio(
  registry: ToolRegistry,
  name: string,
  entry: { command: string; args: readonly string[]; env?: Record<string, string> },
  config: AgentConfig,
  runtime: McpRuntime | undefined,
): Promise<void> {
  const planned = plan_stdio(name, entry.command, entry.args, runtime?.env_path ?? process.env.PATH);
  if (typeof planned === "string") {
    logger.warn(`mcp ${name} skipped: ${planned}`);
    return;
  }
  const spawn = runtime?.spawn ?? default_line_spawner;
  const session = new McpSession(stdio_pipe(spawn(planned.command, planned.args, entry.env)));
  await open_and_register(registry, name, config.tools_enabled, session);
}

export async function attach_http(
  registry: ToolRegistry,
  name: string,
  url: string,
  config: AgentConfig,
  runtime: McpRuntime | undefined,
): Promise<void> {
  const session = new McpSession(http_pipe(url, runtime?.fetch_fn ?? fetch));
  await open_and_register(registry, name, config.tools_enabled, session);
}
