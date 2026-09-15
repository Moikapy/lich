/**
 * HookedToolRunner: wraps the ToolExecutor with plugin hooks.
 *
 * before_tool_call hooks run in registration order and may veto a call (first
 * blocker wins; the wrapped executor is never called). Hook errors are warned
 * and skipped, never fatal. after_tool_call hooks observe the result summary.
 */
import type { ToolContext, ToolResult } from "../tools/types.js";
import { logger } from "../util/log.js";
import type {
  AfterToolCallInfo,
  BeforeToolCallInfo,
  BeforeToolCallResult,
  HookContext,
  PluginHooks,
  RunEndInfo,
} from "./types.js";

const SUMMARY_MAX_CHARS = 300;

/** Structural ToolRunner shape accepted from the wrapped executor. */
export interface WrappedToolRunner {
  execute(name: string, args: Record<string, unknown>, context?: ToolContext): Promise<ToolResult>;
}

function clamp_summary(text: string): string {
  return text.length > SUMMARY_MAX_CHARS ? text.slice(0, SUMMARY_MAX_CHARS) : text;
}

function pick_defined<T>(hooks: readonly PluginHooks[], pick: (hooks_entry: PluginHooks) => T | undefined): T[] {
  const defined: T[] = [];
  for (const hooks_entry of hooks) {
    const hook = pick(hooks_entry);
    if (hook !== undefined) {
      defined.push(hook);
    }
  }
  return defined;
}

/**
 * All hook arrays are pre-flattened at construction so the per-call hot path
 * does no concat; hooks always run in plugin registration order.
 */
export class HookedToolRunner {
  private readonly wrapped: WrappedToolRunner;
  private readonly before_hooks: NonNullable<PluginHooks["before_tool_call"]>[];
  private readonly after_hooks: NonNullable<PluginHooks["after_tool_call"]>[];
  private readonly run_start_hooks: NonNullable<PluginHooks["on_run_start"]>[];
  private readonly run_end_hooks: NonNullable<PluginHooks["on_run_end"]>[];

  constructor(wrapped: WrappedToolRunner, hooks: readonly PluginHooks[]) {
    this.wrapped = wrapped;
    this.before_hooks = pick_defined<NonNullable<PluginHooks["before_tool_call"]>>(hooks, (entry) => entry.before_tool_call);
    this.after_hooks = pick_defined<NonNullable<PluginHooks["after_tool_call"]>>(hooks, (entry) => entry.after_tool_call);
    this.run_start_hooks = pick_defined<NonNullable<PluginHooks["on_run_start"]>>(hooks, (entry) => entry.on_run_start);
    this.run_end_hooks = pick_defined<NonNullable<PluginHooks["on_run_end"]>>(hooks, (entry) => entry.on_run_end);
  }

  /** Run before hooks in order; the first {block: true} verdict wins. */
  private async run_before_hooks(
    info: BeforeToolCallInfo,
    ctx: HookContext,
  ): Promise<BeforeToolCallResult> {
    for (const hook of this.before_hooks) {
      try {
        const verdict = (await hook(info, ctx)) as BeforeToolCallResult | undefined;
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
  private async run_after_hooks(info: AfterToolCallInfo, ctx: HookContext): Promise<void> {
    for (const hook of this.after_hooks) {
      try {
        await hook(info, ctx);
      } catch (hook_error) {
        logger.warn(`plugin after_tool_call hook threw for ${info.tool_name}; continuing`, hook_error);
      }
    }
  }

  async execute(name: string, args: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> {
    const info: BeforeToolCallInfo = { tool_name: name, args };
    const ctx: HookContext = { work_dir: context?.work_dir ?? process.cwd() };
    const verdict = await this.run_before_hooks(info, ctx);
    if (verdict.block === true) {
      const reason = verdict.reason ?? "plugin-less";
      logger.info(`plugin blocked tool ${name}: ${reason}`);
      return { ok: false, output: "", error: `blocked_by_plugin: ${reason}` };
    }
    const result = await this.wrapped.execute(name, args, context);
    const after_info: AfterToolCallInfo = {
      ...info,
      result_summary: clamp_summary(result.error ?? result.output),
    };
    await this.run_after_hooks(after_info, ctx);
    return result;
  }

  /** Best-effort on_run_start fan-out used by Agent.run; never throws. */
  async call_run_start(info: { input_chars: number }, ctx: HookContext): Promise<void> {
    for (const hook of this.run_start_hooks) {
      try {
        await hook(info, ctx);
      } catch (hook_error) {
        logger.warn("plugin on_run_start hook threw; continuing", hook_error);
      }
    }
  }

  /** Best-effort on_run_end fan-out used by Agent.run; never throws. */
  async call_run_end(info: RunEndInfo, ctx: HookContext): Promise<void> {
    for (const hook of this.run_end_hooks) {
      try {
        await hook(info, ctx);
      } catch (hook_error) {
        logger.warn("plugin on_run_end hook threw; continuing", hook_error);
      }
    }
  }
}