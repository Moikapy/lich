/**
 * Plugin surface: user-authored tools and lifecycle hooks loaded at startup.
 *
 * A plugin is a plain object exported from a TS/JS module. Hooks observe and
 * (in the case of before_tool_call) veto tool executions; tools merge into the
 * agent registry after builtin filtering.
 */
import type { Tool } from "../tools/types.js";

/** Runtime info handed to every hook call. */
export interface HookContext {
  work_dir: string;
  /**
   * This plugin's own per-run state sub-map. Every hook invocation receives
   * a ctx exposing only the invoking plugin's bag; the bag is swapped fresh
   * at each run start. Absent only on hand-built contexts outside the runner.
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