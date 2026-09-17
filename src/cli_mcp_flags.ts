/** MCP-only flags. Values are not logged. */
export interface McpCliFlags {
  command?: string;
  args: string[];
  url?: string;
  project_path?: string;
}

export function empty_mcp_flags(): McpCliFlags {
  return { args: [] };
}

/** Consume one mcp flag. Returns the new index, or undefined if not ours. */
export function take_mcp_flag(argv: readonly string[], index: number, flags: McpCliFlags): number | undefined {
  const arg = argv[index];
  if (arg === "--arg") {
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error("--arg requires a value");
    }
    flags.args.push(value);
    return index + 1;
  }
  if (arg !== "--command" && arg !== "--url" && arg !== "--project-path") {
    return undefined;
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--") === true) {
    throw new Error(`${arg} requires a value`);
  }
  if (arg === "--command") {
    flags.command = value;
  }
  if (arg === "--url") {
    flags.url = value;
  }
  if (arg === "--project-path") {
    flags.project_path = value;
  }
  return index + 1;
}
