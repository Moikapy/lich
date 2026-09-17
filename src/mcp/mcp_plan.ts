/**
 * Resolve a named stdio entry to an argv. Never spawns and never downloads.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { catalog_by_name } from "./mcp_catalog.js";
import { refuse_mcp_entry } from "./mcp_pin.js";

export interface StdioPlan {
  command: string;
  args: readonly string[];
}

function find_on_path(command: string, env_path: string | undefined): string | undefined {
  if (env_path === undefined || env_path.length === 0) {
    return undefined;
  }
  for (const dir of env_path.split(path.delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    const candidate = path.join(dir, command);
    if (existsSync(candidate) === true) {
      return candidate;
    }
  }
  return undefined;
}

function locate(command: string, env_path: string | undefined): string | undefined {
  if (command.includes("/") === true || command.includes("\\") === true) {
    return existsSync(command) === true ? command : undefined;
  }
  return find_on_path(command, env_path);
}

export function plan_stdio(
  name: string,
  command: string,
  args: readonly string[],
  env_path: string | undefined,
): StdioPlan | string {
  const refused = refuse_mcp_entry(name, { command, args });
  if (refused !== undefined) {
    return refused;
  }
  const binary = locate(command, env_path);
  if (binary === undefined) {
    return catalog_by_name(name)?.missing_hint ?? "mcp command not found";
  }
  return { command: binary, args };
}
