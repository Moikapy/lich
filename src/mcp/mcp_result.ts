import type { JsonSchemaObject } from "../util/json_schema.js";

export interface ListedTool {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}

function tool_schema(raw: unknown): JsonSchemaObject {
  if (typeof raw !== "object" || raw === null) {
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
    if (typeof tool.name !== "string" || tool.name.length === 0) {
      continue;
    }
    tools.push({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : tool.name,
      parameters: tool_schema(tool.inputSchema),
    });
  }
  return tools;
}
