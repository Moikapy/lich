/**
 * Plugin surface: user-authored tools and lifecycle hooks loaded at startup.
 *
 * A plugin is a plain object exported from a TS/JS module. Hooks observe and
 * (in the case of before_tool_call) veto tool executions; tools merge into the
 * agent registry after builtin filtering.
 */
import type { ChatOptions, ChatResult, Message } from "../providers/types.js";
import type { Tool } from "../tools/types.js";

/** Model roles a plugin entry may be granted (`models` in config). */
export const MODEL_ROLES = ["chat", "compress"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/** One `plugins` config entry: a bare module path, or a path with settings and granted roles. */
export type PluginEntry =
  | string
  | { path: string; settings?: Record<string, unknown>; models?: readonly ModelRole[] };

/** Host-owned model access for one plugin; roles not granted in config are refused. */
export interface PluginModels {
  chat(role: ModelRole, messages: readonly Message[], options?: ChatOptions): Promise<ChatResult>;
}

/** What the host hands one plugin: its frozen config settings and model access. */
export interface PluginAccess {
  settings: Readonly<Record<string, unknown>>;
  models: PluginModels;
}

/** Runtime info handed to every hook call. */
export interface HookContext {
  work_dir: string;
  /** This plugin's frozen `settings` from its config entry (`{}` when none). */
  settings?: Readonly<Record<string, unknown>>;
  /** Model access limited to the roles granted in this plugin's config entry. */
  models?: PluginModels;
  /**
   * This plugin's own per-run state sub-map. Every hook invocation receives
   * a ctx exposing only the invoking plugin's bag; the bag is scoped per
   * Agent.run via AsyncLocalStorage (and swapped fresh at each run start).
   * Absent only on hand-built contexts outside the runner.
   */
  state?: Map<string, unknown>;
}

/** Argument passed to before_tool_call hooks. */
export interface BeforeToolCallInfo {
  tool_name: string;
  args: Record<string, unknown>;
}

/** Return value that vetoes a tool call; other hooks still run. */
export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
}

/** Argument passed to after_tool_call hooks. */
export interface AfterToolCallInfo extends BeforeToolCallInfo {
  result_summary: string;
  /** Structured executor outcome; gate on this, never parse result_summary. */
  ok: boolean;
  error?: string;
}

/** Argument passed to before_llm_call hooks; `messages` is a copy of the history for this call. */
export interface BeforeLlmCallInfo {
  turn: number;
  messages: readonly Message[];
}

/** A note added to this one model call only, never to the saved history. */
export interface BeforeLlmCallResult {
  note?: string;
}

export interface RunEndInfo {
  stopped_reason: string;
  turns_used: number;
}

/** Optional lifecycle hooks a plugin may implement. All hooks are awaited. */
export interface PluginHooks {
  before_tool_call?(
    info: BeforeToolCallInfo,
    ctx: HookContext,
  ): Promise<BeforeToolCallResult | void> | BeforeToolCallResult | void;
  after_tool_call?(info: AfterToolCallInfo, ctx: HookContext): Promise<void> | void;
  /** Runs before each main-loop model call; a returned note is capped and fails open. */
  before_llm_call?(
    info: BeforeLlmCallInfo,
    ctx: HookContext,
  ): Promise<BeforeLlmCallResult | void> | BeforeLlmCallResult | void;
  on_run_start?(info: { input_chars: number }, ctx: HookContext): Promise<void> | void;
  on_run_end?(info: RunEndInfo, ctx: HookContext): Promise<void> | void;
}

/** A user plugin: required unique name, optional tools and hooks. */
export interface Plugin {
  name: string;
  version?: string;
  tools?: Tool[];
  hooks?: PluginHooks;
}