/**
 * HookedToolRunner: wraps the ToolExecutor with plugin hooks.
 *
 * before_tool_call hooks run in registration order and may veto a call (first
 * blocker wins; the wrapped executor is never called). Hook errors are warned
 * and skipped, never fatal. after_tool_call hooks observe the result summary
 * plus the executor's structured ok/error fields. Every hook invocation
 * receives a ctx exposing only its own plugin's state sub-map: bags are keyed
 * per AsyncLocalStorage run scope (M-6) with a WeakMap fallback for tests that
 * call hooks without run_scope.
 */
import { AsyncLocalStorage } from "node:async_hooks";
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

type PluginBags = Map<Plugin, Map<string, unknown>>;

/** Per-run bags when Agent.run wraps work in run_scope (concurrent-safe). */
const run_als = new AsyncLocalStorage<PluginBags>();

/** Fallback for tests / callers that do not enter run_scope. */
const plugin_state = new WeakMap<Plugin, Map<string, unknown>>();

function bags_for_run(): PluginBags | undefined {
  return run_als.getStore();
}

/** The plugin's current sub-map; created on first sight for pre-run calls. */
function hook_state_for(plugin: Plugin): Map<string, unknown> {
  const bags = bags_for_run();
  if (bags !== undefined) {
    let state = bags.get(plugin);
    if (state === undefined) {
      state = new Map();
      bags.set(plugin, state);
    }
    return state;
  }
  let state = plugin_state.get(plugin);
  if (state === undefined) {
    state = new Map();
    plugin_state.set(plugin, state);
  }
  return state;
}

function reset_plugin_bag(plugin: Plugin): Map<string, unknown> {
  const fresh = new Map<string, unknown>();
  const bags = bags_for_run();
  if (bags !== undefined) {
    bags.set(plugin, fresh);
  } else {
    plugin_state.set(plugin, fresh);
  }
  return fresh;
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

  /**
   * Isolate plugin state for one Agent.run so concurrent runs on the same
   * Agent cannot reset each other's bags (M-6).
   */
  run_scope<T>(fn: () => Promise<T>): Promise<T> {
    const bags: PluginBags = new Map();
    for (const plugin of this.hooked_plugins) {
      bags.set(plugin, new Map());
    }
    return run_als.run(bags, fn);
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
      reset_plugin_bag(plugin);
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
