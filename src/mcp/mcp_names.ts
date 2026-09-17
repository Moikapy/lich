/** Hermes-style prefix so two servers cannot register the same tool name. */
export function mcp_tool_name(server: string, tool: string): string {
  return `mcp_${sanitize(server)}_${sanitize(tool)}`;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_");
}
