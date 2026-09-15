import type { ToolDefinition } from "../providers/types.js";
import type { Tool, ToolContext, Toolset } from "./types.js";

/**
 * Name-keyed registry of tools and toolsets. Registration rejects duplicate
 * tool names so conflicting builtins fail loudly at startup.
 */
export class ToolRegistry {
  private readonly tools: Map<string, Tool> = new Map();

  register(tool: Tool): void {
    if (this.tools.has(tool.name) === true) {
      throw new Error(`duplicate_tool: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  register_toolset(toolset: Toolset): void {
    for (const tool of toolset.tools) {
      this.register(tool);
    }
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** Map registered tools onto the provider-facing wire shape. */
  definitions(): ToolDefinition[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }
}

/** Build a bare ToolContext for ad-hoc / default execution. */
export function default_tool_context(work_dir: string, env?: Record<string, string>): ToolContext {
  return { work_dir, env: env ?? {} };
}