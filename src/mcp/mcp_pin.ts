/** Catalog pins. A custom server name is not pinned unless the command basename matches. */
import path from "node:path";
import { catalog_by_basename, catalog_by_name, type CatalogManifest } from "./mcp_catalog.js";
import { refuse_stdio_arg, refuse_stdio_command, type McpEntryShape } from "./mcp_refuse.js";
import { refuse_http_url } from "./mcp_url.js";

export function pin_for(name: string, command?: string): CatalogManifest | undefined {
  const by_name = catalog_by_name(name);
  if (by_name?.command_basename !== undefined) {
    return by_name;
  }
  if (command === undefined) {
    return by_name;
  }
  return catalog_by_basename(path.basename(command)) ?? by_name;
}

export function refuse_catalog_stdio(name: string, command: string, args: readonly string[]): string | undefined {
  const pin = pin_for(name, command);
  if (pin?.command_basename === undefined) {
    return undefined;
  }
  if (path.basename(command) !== pin.command_basename) {
    return `refused command basename '${path.basename(command)}'; only '${pin.command_basename}' is allowed`;
  }
  const prefix = pin.args_prefix ?? [];
  if (args.length !== prefix.length + 1) {
    return `refused ${pin.name} args; expected ${prefix.join(" ")} <project>`;
  }
  for (let index = 0; index < prefix.length; index += 1) {
    if (args[index] !== prefix[index]) {
      return `refused ${pin.name} args; expected ${prefix.join(" ")} <project>`;
    }
  }
  const project = args[prefix.length];
  if (project === undefined || project.length === 0 || project.includes("://") === true) {
    return "refused project path; pass a local project directory";
  }
  return undefined;
}

function refuse_arg_list(args: readonly string[]): string | undefined {
  for (const arg of args) {
    const refused = refuse_stdio_arg(arg);
    if (refused !== undefined) {
      return refused;
    }
  }
  return undefined;
}

/** Closed-entry check used at parse and again before spawn. */
export function refuse_mcp_entry(name: string, entry: McpEntryShape): string | undefined {
  if (typeof entry.url === "string") {
    return refuse_http_url(entry.url);
  }
  if (typeof entry.command !== "string") {
    return "refused mcp entry";
  }
  const args = entry.args ?? [];
  return (
    refuse_stdio_command(entry.command, args) ??
    refuse_catalog_stdio(name, entry.command, args) ??
    refuse_arg_list(args)
  );
}
