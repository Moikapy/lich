import type { JsonSchemaObject } from "../util/json_schema.js";

/** Provider-safe caps on untrusted MCP tools/list metadata. */
export const MCP_NAME_MAX = 64;
export const MCP_DESC_MAX = 2000;
export const MCP_SCHEMA_JSON_MAX = 16000;

export interface ListedTool {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}

function clamp_text(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function schema_within_budget(raw: unknown): boolean {
  try {
    return JSON.stringify(raw).length <= MCP_SCHEMA_JSON_MAX;
  } catch {
    return false;
  }
}

function tool_schema(raw: unknown): JsonSchemaObject {
  if (typeof raw !== "object" || raw === null || schema_within_budget(raw) === false) {
    return { type: "object" };
  }
  const body = raw as { properties?: unknown; required?: unknown; additionalProperties?: unknown };
  const schema: JsonSchemaObject = { type: "object" };
  if (typeof body.properties === "object" && body.properties !== null) {
    schema.properties = body.properties as JsonSchemaObject["properties"];
  }
  if (Array.isArray(body.required) === true) {
    schema.required = body.required.filter((item): item is string => typeof item === "string");
  }
  if (typeof body.additionalProperties === "boolean") {
    schema.additionalProperties = body.additionalProperties;
  }
  return schema;
}

export function parse_tools(result: unknown): ListedTool[] {
  if (typeof result !== "object" || result === null || Array.isArray((result as { tools?: unknown }).tools) === false) {
    throw new Error("mcp tools/list rejected");
  }
  const tools: ListedTool[] = [];
  for (const item of (result as { tools: unknown[] }).tools) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const tool = item as { name?: unknown; description?: unknown; inputSchema?: unknown };
    if (typeof tool.name !== "string" || tool.name.length === 0 || tool.name.length > MCP_NAME_MAX) {
      continue;
    }
    const description =
      typeof tool.description === "string" ? clamp_text(tool.description, MCP_DESC_MAX) : tool.name;
    tools.push({
      name: tool.name,
      description,
      parameters: tool_schema(tool.inputSchema),
    });
  }
  return tools;
}
