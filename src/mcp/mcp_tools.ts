/**
 * Discover tools/list for each enabled server and register mcp_<server>_<tool>.
 * tools_enabled filters them. An empty allowlist never connects.
 */
import type { AgentConfig } from "../agent/config.js";
import type { ToolRegistry } from "../tools/registry.js";
import { logger } from "../util/log.js";
import { attach_http, attach_stdio } from "./mcp_attach.js";
import type { LineSpawner } from "./mcp_stdio.js";

export interface McpRuntime {
  spawn?: LineSpawner;
  fetch_fn?: typeof fetch;
  env_path?: string;
}

function allowlist_wants_mcp(enabled: AgentConfig["tools_enabled"]): boolean {
  if (enabled === "all") {
    return true;
  }
  return enabled.some((name) => name.startsWith("mcp_") === true);
}

export async function attach_enabled_mcp_tools(
  registry: ToolRegistry,
  config: AgentConfig,
  runtime?: McpRuntime,
): Promise<void> {
  const servers = config.mcp_servers;
  if (servers === undefined || allowlist_wants_mcp(config.tools_enabled) === false) {
    return;
  }
  for (const [name, entry] of Object.entries(servers)) {
    if (entry.enabled !== true) {
      continue;
    }
    try {
      if ("url" in entry) {
        await attach_http(registry, name, entry.url, config, runtime);
        continue;
      }
      await attach_stdio(registry, name, entry, config, runtime);
    } catch (error) {
      const message = error instanceof Error ? error.message : "mcp skipped";
      logger.warn(`mcp ${name} skipped: ${message}`);
    }
  }
}
