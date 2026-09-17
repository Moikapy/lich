/** Flip or delete one mcp_servers entry. Does not print env. */
import { require_server_name } from "./cli_mcp_add.js";
import { mcp_servers_of, read_work_config, save_mcp_servers } from "./cli_mcp_store.js";

function require_entry(
  servers: Record<string, Record<string, unknown>>,
  name: string,
): Record<string, unknown> {
  const entry = servers[name];
  if (entry === undefined) {
    throw new Error(`mcp server '${name}' not found`);
  }
  return entry;
}

export function set_mcp_enabled(work_dir: string, name: string | undefined, enabled: boolean): string {
  const server = require_server_name(name, enabled === true ? "enable" : "disable");
  const current = read_work_config(work_dir);
  const servers = mcp_servers_of(current);
  const entry = require_entry(servers, server);
  servers[server] = { ...entry, enabled };
  save_mcp_servers(work_dir, current, servers);
  return enabled === true ? `enabled ${server}` : `disabled ${server}`;
}

export function remove_mcp_server(work_dir: string, name: string | undefined): string {
  const server = require_server_name(name, "remove");
  const current = read_work_config(work_dir);
  const servers = mcp_servers_of(current);
  require_entry(servers, server);
  delete servers[server];
  save_mcp_servers(work_dir, current, servers);
  return `removed ${server}`;
}
