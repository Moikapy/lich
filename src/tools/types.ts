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