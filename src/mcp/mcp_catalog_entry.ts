/**
 * Install shape: turn a catalog manifest into a disabled mcp_servers entry.
 * Does not spawn, download, or copy secrets.
 */
import { catalog_by_name } from "./mcp_catalog.js";

const PLACEHOLDER = /\$\{([a-z_]+)\}/g;

function expand(value: string, substitutes: Record<string, string>): string | undefined {
  const tokens = value.match(PLACEHOLDER) ?? [];
  let next = value;
  for (const token of tokens) {
    const key = token.slice(2, -1);
    const found = substitutes[key];
    if (found === undefined || found.length === 0) {
      return undefined;
    }
    next = next.replace(token, found);
  }
  return next;
}

/** Write the client entry. The user sets enabled. Godot has nothing to write. */
export function catalog_client_entry(
  name: string,
  substitutes: Record<string, string> = {},
): Record<string, unknown> | string {
  const manifest = catalog_by_name(name);
  if (manifest === undefined) {
    return `unknown mcp catalog entry '${name}'`;
  }
  if (manifest.transport !== "stdio" || manifest.command === undefined) {
    return manifest.note ?? `${name} has no official mcp server to enable`;
  }
  const args: string[] = [];
  for (const arg of manifest.args ?? []) {
    const expanded = expand(arg, substitutes);
    if (expanded === undefined) {
      return `mcp catalog '${name}' needs a substitute for ${arg}`;
    }
    args.push(expanded);
  }
  return { enabled: false, command: manifest.command, args };
}
