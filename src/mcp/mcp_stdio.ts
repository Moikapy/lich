/**
 * Spawn a planned local binary over stdio. Bun when the process is Bun,
 * otherwise node child_process. Callers must already have refused bad commands.
 */
import type { LineChild } from "./mcp_child.js";
import { bun_line_child } from "./mcp_stdio_bun.js";
import { node_line_child } from "./mcp_stdio_node.js";

export type { LineChild, LineSpawner } from "./mcp_child.js";

function running_under_bun(): boolean {
  return process.versions.bun !== undefined;
}

export function default_line_spawner(command: string, args: readonly string[], env?: Record<string, string>): LineChild {
  if (running_under_bun() === true) {
    return bun_line_child(command, args, env);
  }
  return node_line_child(command, args, env);
}
