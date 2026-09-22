/**
 * Public surface of the lich agent harness. Pure re-exports, plus the package version.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function read_package_version(): string {
  const pkg_path = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(readFileSync(pkg_path, "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error("package.json is missing version");
  }
  return pkg.version;
}

export const LICH_VERSION = read_package_version();

export { Agent, create_agent, run_agent, create_agent_with_plugins } from "./agent/agent.js";
export type { AgentRunOptions, AgentRunResult } from "./agent/agent.js";
export type { AgentConfig } from "./agent/config.js";
export { parse_agent_config } from "./agent/config.js";
export { catalog_client_entry } from "./mcp/mcp_catalog_entry.js";
export { AgentEmitter } from "./agent/events.js";
export type { AgentEvent, AgentEventHandler, AgentEvents } from "./agent/events.js";
export { run_conversation } from "./agent/loop.js";
export type { LoopDeps, LoopOutcome, LoopParams, ToolRunner } from "./agent/loop.js";
export { open_session, read_session_messages } from "./session/store.js";
export type {
  AssistantMessage,
  ChatOptions,
  ChatResult,
  Message,
  ProviderConfig,
  ToolCall,
  ToolDefinition,
  Usage,
} from "./providers/types.js";
export { ProviderError } from "./providers/types.js";
export type { JsonSchemaObject } from "./util/json_schema.js";
export { ToolExecutor } from "./tools/executor.js";
export { ToolRegistry } from "./tools/registry.js";
export type { Tool, ToolContext, ToolResult } from "./tools/types.js";
export { register_builtin_tools } from "./tools/builtin/index.js";
export { HookedToolRunner } from "./plugins/hooks.js";
export { load_plugins, plugin_errors_summary } from "./plugins/loader.js";
export type { LoadedPlugin, PluginLoadError } from "./plugins/loader.js";
export type {
  AfterToolCallInfo,
  BeforeToolCallInfo,
  BeforeToolCallResult,
  HookContext,
  Plugin,
  PluginHooks,
  RunEndInfo,
} from "./plugins/types.js";