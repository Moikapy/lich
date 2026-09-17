/** Build a disabled mcp_servers entry. Does not write or log env. */
import { catalog_client_entry } from "./mcp/mcp_catalog_entry.js";
import { refuse_mcp_entry } from "./mcp/mcp_pin.js";
import type { McpCliFlags } from "./cli_mcp_flags.js";

const SERVER_NAME = /^[a-z][a-z0-9_]*$/;

export function require_server_name(name: string | undefined, action: string): string {
  if (name === undefined || SERVER_NAME.test(name) === false) {
    throw new Error(`mcp ${action} requires a snake_case name`);
  }
  return name;
}

function entry_from_flags(name: string, flags: McpCliFlags): Record<string, unknown> {
  if (flags.command !== undefined && flags.url !== undefined) {
    throw new Error("mcp add accepts --command or --url, not both");
  }
  if (flags.url !== undefined) {
    if (flags.args.length > 0) {
      throw new Error("mcp add --url does not take --arg");
    }
    return { enabled: false, url: flags.url };
  }
  if (flags.command === undefined) {
    throw new Error("mcp add needs a catalog entry, --command, or --url");
  }
  return { enabled: false, command: flags.command, args: [...flags.args] };
}

function entry_from_catalog(name: string, flags: McpCliFlags): Record<string, unknown> {
  const substitutes: Record<string, string> = {};
  if (flags.project_path !== undefined) {
    substitutes["project_path"] = flags.project_path;
  }
  const built = catalog_client_entry(name, substitutes);
  if (typeof built === "string") {
    throw new Error(built);
  }
  return built;
}

export function build_mcp_entry(name: string, flags: McpCliFlags): Record<string, unknown> {
  const entry = flags.command !== undefined || flags.url !== undefined
    ? entry_from_flags(name, flags)
    : entry_from_catalog(name, flags);
  const refused = refuse_mcp_entry(name, {
    command: typeof entry["command"] === "string" ? entry["command"] : undefined,
    args: Array.isArray(entry["args"]) ? entry["args"].filter((arg): arg is string => typeof arg === "string") : [],
    url: typeof entry["url"] === "string" ? entry["url"] : undefined,
  });
  if (refused !== undefined) {
    throw new Error(refused);
  }
  return entry;
}
