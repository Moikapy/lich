import { clamp_output, error_result, with_timeout, DEFAULT_TOOL_TIMEOUT_MS } from "./guard.js";
import { default_tool_context, ToolRegistry } from "./registry.js";
import { logger } from "../util/log.js";
import { safe_stringify } from "../util/json.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

export interface ExecutorDefaults {
  work_dir?: string;
  env?: Record<string, string>;
}

function clamp_result(result: ToolResult): ToolResult {
  return { ...result, output: clamp_output(result.output) };
}

function failure_result(err: unknown, context: ToolContext): ToolResult {
  if (context.signal?.aborted === true) {
    return { ok: false, output: "", error: "cancelled" };
  }
  return error_result(err);
}

/**
 * Executes registry tools, never throws. Applies a per-call timeout, abort
 * propagation (external signal and timeout both abort the tool's signal),
 * error capture, and output clamping.
 */
export class ToolExecutor {
  private readonly registry: ToolRegistry;
  private readonly defaults: ExecutorDefaults;

  constructor(registry: ToolRegistry, defaults?: ExecutorDefaults) {
    this.registry = registry;
    this.defaults = defaults ?? {};
  }

  async execute(name: string, args: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> {
    const tool = this.registry.get(name);
    if (tool === undefined) {
      return { ok: false, output: "", error: `unknown_tool: ${name}` };
    }
    const resolved = context ?? default_tool_context(this.defaults.work_dir ?? process.cwd(), this.defaults.env);
    if (resolved.signal?.aborted === true) {
      return { ok: false, output: "", error: "cancelled" };
    }
    return this.run_tool(tool, args, resolved);
  }

  private async run_tool(tool: Tool, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const combined = new AbortController();
    const link_external = (): void => {
      combined.abort();
    };
    context.signal?.addEventListener("abort", link_external, { once: true });
    logger.debug(`tool_call_start: ${tool.name}`);
    try {
      const result = await with_timeout(
        (timeout_signal) => {
          timeout_signal.addEventListener("abort", () => {
            combined.abort();
          }, { once: true });
          return tool.execute(args, { ...context, signal: combined.signal });
        },
        DEFAULT_TOOL_TIMEOUT_MS,
        `tool:${tool.name}`,
      );
      logger.debug(`tool_call_end: ${tool.name}`);
      return clamp_result(result);
    } catch (err) {
      logger.debug(`tool_call_error: ${tool.name}`);
      return failure_result(err, context);
    } finally {
      context.signal?.removeEventListener("abort", link_external);
    }
  }

  /** Render a result for a tool-role message: JSON on error, raw output otherwise. */
  static format_result(result: ToolResult): string {
    if (result.error !== undefined && result.error.length > 0) {
      return safe_stringify({ ok: result.ok, output: result.output, error: result.error });
    }
    return result.output;
  }
}