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

/** Attach deadline so a silent server cannot block Agent.run forever. */
const ATTACH_TIMEOUT_MS = 15000;

function with_timeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ATTACH_TIMEOUT_MS}ms`));
    }, ATTACH_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function open_and_register(
  registry: ToolRegistry,
  name: string,
  enabled: AgentConfig["tools_enabled"],
  session: McpSession,
  command?: string,
): Promise<McpSession | undefined> {
  try {
    const listed = await with_timeout(session.list_tools(), `mcp ${name} attach`);
    register_listed(registry, name, listed, enabled, session, command);
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
  return open_and_register(registry, name, config.tools_enabled, session, planned.command);
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
