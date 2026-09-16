/**
 * HookedToolRunner: wraps the ToolExecutor with plugin hooks.
 *
 * before_tool_call hooks run in registration order and may veto a call (first
 * blocker wins; the wrapped executor is never called). Hook errors are warned
 * and skipped, never fatal. after_tool_call hooks observe the result summary
 * plus the executor's structured ok/error fields. Every hook invocation
 * receives a ctx exposing only its own plugin's state sub-map: the bag is a
 * module-internal WeakMap keyed on the plugin object, swapped fresh at each
 * call_run_start and shared by the lifecycle and per-tool ctx build sites.
 */
import type { ToolContext, ToolResult } from "../tools/types.js";
import { logger } from "../util/log.js";
import type {
  AfterToolCallInfo,
  BeforeToolCallInfo,
  BeforeToolCallResult,
  HookContext,
  Plugin,
  RunEndInfo,
} from "./types.js";

const SUMMARY_MAX_CHARS = 300;

/** Structural ToolRunner shape accepted from the wrapped executor. */
export interface WrappedToolRunner {
  execute(name: string, args: Record<string, unknown>, context?: ToolContext): Promise<ToolResult>;
}

/** Module-internal per-run state channel, keyed on the plugin object (A8). */
const plugin_state = new WeakMap<Plugin, Map<string, unknown>>();

/** The plugin's current sub-map; created on first sight for pre-run calls. */
function hook_state_for(plugin: Plugin): Map<string, unknown> {
  let state = plugin_state.get(plugin);
  if (state === undefined) {
    state = new Map();
    plugin_state.set(plugin, state);
  }
  return state;
}

/** Per-invocation ctx: base plus ONLY this plugin's own sub-map (A8). */
function with_hook_state(base: HookContext, plugin: Plugin): HookContext {
  return { ...base, state: hook_state_for(plugin) };
}

function clamp_summary(text: string): string {
  return text.length > SUMMARY_MAX_CHARS ? text.slice(0, SUMMARY_MAX_CHARS) : text;
}

/**
 * Hooks stay attached to their plugin (no flattening) so each invocation can
 * be handed a ctx exposing only that plugin's sub-map; hooks always run in
 * plugin registration order.
 */
export class HookedToolRunner {
  private readonly wrapped: WrappedToolRunner;
  private readonly hooked_plugins: Plugin[];

  constructor(wrapped: WrappedToolRunner, plugins: readonly Plugin[]) {
    this.wrapped = wrapped;
    this.hooked_plugins = plugins.filter((plugin) => plugin.hooks !== undefined);
  }

  /** Run before hooks in order; the first {block: true} verdict wins. */
  private async run_before_hooks(
    info: BeforeToolCallInfo,
    base: HookContext,
  ): Promise<BeforeToolCallResult> {
    for (const plugin of this.hooked_plugins) {
      const hook = plugin.hooks?.before_tool_call;
      if (hook === undefined) {
        continue;
      }
      try {
        const verdict = (await hook(info, with_hook_state(base, plugin))) as BeforeToolCallResult | undefined;
        if (verdict?.block === true) {
          return verdict;
        }
      } catch (hook_error) {
        logger.warn(`plugin before_tool_call hook threw for ${info.tool_name}; continuing`, hook_error);
      }
    }
    return {};
  }

  /** Fire-and-forget in spirit but awaited here so runs settle cleanly. */
  private async run_after_hooks(info: AfterToolCallInfo, base: HookContext): Promise<void> {
    for (const plugin of this.hooked_plugins) {
      const hook = plugin.hooks?.after_tool_call;
      if (hook === undefined) {
        continue;
      }
      try {
        await hook(info, with_hook_state(base, plugin));
      } catch (hook_error) {
        logger.warn(`plugin after_tool_call hook threw for ${info.tool_name}; continuing`, hook_error);
      }
    }
  }

  async execute(name: string, args: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> {
    const info: BeforeToolCallInfo = { tool_name: name, args };
    const base: HookContext = { work_dir: context?.work_dir ?? process.cwd() };
    const verdict = await this.run_before_hooks(info, base);
    if (verdict.block === true) {
      const reason = verdict.reason ?? "plugin-less";
      logger.info(`plugin blocked tool ${name}: ${reason}`);
      return { ok: false, output: "", error: `blocked_by_plugin: ${reason}` };
    }
    const result = await this.wrapped.execute(name, args, context);
    const after_info: AfterToolCallInfo = {
      ...info,
      result_summary: clamp_summary(result.error ?? result.output),
      ok: result.ok,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
    await this.run_after_hooks(after_info, base);
    return result;
  }

  /** Best-effort on_run_start fan-out used by Agent.run; never throws. Swaps in a fresh state sub-map per hooked plugin first. */
  async call_run_start(info: { input_chars: number }, base: HookContext): Promise<void> {
    for (const plugin of this.hooked_plugins) {
      plugin_state.set(plugin, new Map());
    }
    for (const plugin of this.hooked_plugins) {
      const hook = plugin.hooks?.on_run_start;
      if (hook === undefined) {
        continue;
      }
      try {
        await hook(info, with_hook_state(base, plugin));
      } catch (hook_error) {
        logger.warn("plugin on_run_start hook threw; continuing", hook_error);
      }
    }
  }

  /** Best-effort on_run_end fan-out used by Agent.run; never throws. */
  async call_run_end(info: RunEndInfo, base: HookContext): Promise<void> {
    for (const plugin of this.hooked_plugins) {
      const hook = plugin.hooks?.on_run_end;
      if (hook === undefined) {
        continue;
      }
      try {
        await hook(info, with_hook_state(base, plugin));
      } catch (hook_error) {
        logger.warn("plugin on_run_end hook threw; continuing", hook_error);
      }
    }
  }
}