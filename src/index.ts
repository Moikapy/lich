/**
 * Public surface of the lich agent harness. Pure re-exports only.
 */
export const LICH_VERSION = "0.3.0";

export { Agent, create_agent, run_agent, create_agent_with_plugins } from "./agent/agent.js";
export type { AgentRunOptions, AgentRunResult } from "./agent/agent.js";
export type { AgentConfig } from "./agent/config.js";
export { parse_agent_config } from "./agent/config.js";
export { AgentEmitter } from "./agent/events.js";
export type { AgentEvent, AgentEventHandler, AgentEvents } from "./agent/events.js";
export type { LoopOutcome, LoopParams } from "./agent/loop.js";
export type {
  ChatOptions,
  ChatResult,
  Message,
  ProviderConfig,
  ToolCall,
  ToolDefinition,
  Usage,
} from "./providers/types.js";
export { ProviderError } from "./providers/types.js";
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