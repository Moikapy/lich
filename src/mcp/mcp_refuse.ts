/**
 * Refuse downloaders, shells, and catalog pins before anything is spawned.
 */
import path from "node:path";
import { catalog_by_name } from "./mcp_catalog.js";
import { refuse_http_url } from "./mcp_url.js";

const SHELL = /[;&|`$<>]/;
const DOWNLOADERS = new Set(["npx", "npm", "bunx", "uvx", "curl", "wget"]);

export interface McpEntryShape {
  command?: string;
  args?: readonly string[];
  url?: string;
}

export function refuse_stdio_command(command: string): string | undefined {
  if (command.includes("://") === true) {
    return "refused url; only a local binary is allowed";
  }
  if (SHELL.test(command) === true) {
    return "refused shell metacharacters in mcp command";
  }
  if (command.length === 0 || command.trim() !== command || /\s/.test(command) === true) {
    return "refused mcp command";
  }
  const base = path.basename(command);
  if (DOWNLOADERS.has(base) === true) {
    return `refused download command '${base}'`;
  }
  return undefined;
}

export function refuse_stdio_arg(arg: string): string | undefined {
  if (arg.includes("://") === true) {
    return "refused url in mcp args";
  }
  if (SHELL.test(arg) === true) {
    return "refused shell metacharacters in mcp args";
  }
  return undefined;
}
