/**
 * Public surface of the lich agent harness. Pure re-exports, plus the package version.
 */
export { LICH_VERSION } from "./version.js";

export { Agent, create_agent, run_agent, create_agent_with_plugins } from "./agent/agent.js";
export type { AgentRunOptions, AgentRunResult } from "./agent/agent.js";
export type { AgentConfig } from "./agent/config.js";
export { parse_agent_config } from "./agent/config.js";
export { catalog_client_entry } from "./mcp/mcp_catalog_entry.js";
export {
  AgentEmitter,
  EnvelopedAgentEmitter,
  to_agent_error_payload,
} from "./agent/events.js";
export type {
  AgentErrorPayload,
  AgentEvent,
  AgentEventBody,
  AgentEventBodyHandler,
  AgentEventHandler,
  AgentEventBodies,
  AgentEvents,
  EventEnvelope,
  RunStoppedReason,
  RunEndReason,
} from "./agent/events.js";
export { run_conversation } from "./agent/loop.js";
export type { LoopDeps, LoopOutcome, LoopParams, ToolRunner } from "./agent/loop.js";
export { open_session, read_session_messages } from "./session/store.js";
export type { SessionHandle } from "./session/store.js";
export { create_session_manager } from "./session/manager.js";
export type { SessionManager } from "./session/manager.js";
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
export {
  SERVE_METHODS,
  SERVE_NOTIFICATION_EVENT,
  SERVE_ERROR_CODES,
} from "./serve/protocol.js";
export type {
  HealthParams,
  HealthResult,
  JsonRpcError,
  JsonRpcErrorBody,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccess,
  PromptAbortParams,
  PromptAbortResult,
  PromptSubmitParams,
  PromptSubmitResult,
  ServeEventNotification,
  ServeEventParams,
  ServeMethod,
  ServeMethodMap,
  ServeNotificationMethod,
  ServeRequest,
  ServeSuccess,
  SessionClearParams,
  SessionClearResult,
  SessionCreateParams,
  SessionCreateResult,
  SessionListEntry,
  SessionListParams,
  SessionListResult,
  SessionResumeParams,
  SessionResumeResult,
} from "./serve/protocol.js";
export {
  create_serve_server,
  DEFAULT_SERVE_HOST,
  DEFAULT_SERVE_PORT,
} from "./serve/server.js";
export type { ServeBootInfo, ServeOptions, ServeServer } from "./serve/server.js";
export { handle_serve_rpc_message } from "./serve/rpc.js";
export type { ServeRpcContext } from "./serve/rpc.js";
export { create_serve_prompt_service } from "./serve/prompts.js";
export type { ServeEventNotify, ServePromptService } from "./serve/prompts.js";
export {
  create_serve_session_store,
  DEFAULT_SERVE_SESSION_LIMIT,
  ServeSessionError,
} from "./serve/sessions.js";
export type { ServeSessionBag, ServeSessionErrorKind, ServeSessionStore } from "./serve/sessions.js";
export { resolve_session_path, SessionResolveError } from "./session/resolve.js";
export type { SessionResolveErrorKind } from "./session/resolve.js";