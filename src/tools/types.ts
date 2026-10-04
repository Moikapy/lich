import type { PluginModels } from "../plugins/types.js";
import type { JsonSchemaObject } from "../util/json_schema.js";

export interface ToolResult {
  ok: boolean;
  output: string;
  error?: string;
}

export interface ToolContext {
  work_dir: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  /** Plugin tools only: the owning plugin's frozen config settings. */
  settings?: Readonly<Record<string, unknown>>;
  /** Plugin tools only: model access limited to the owning plugin's granted roles. */
  models?: PluginModels;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
  /** Per-tool executor timeout override in ms; unset tools get the 30s default. */
  timeout_ms?: number;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export interface Toolset {
  name: string;
  tools: Tool[];
}