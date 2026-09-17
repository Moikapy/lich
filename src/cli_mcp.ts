/** Non-interactive `lich mcp`. Edits work-dir config only. */
import { build_mcp_entry, require_server_name } from "./cli_mcp_add.js";
import { remove_mcp_server, set_mcp_enabled } from "./cli_mcp_edit.js";
import type { McpCliFlags } from "./cli_mcp_flags.js";
import { list_mcp_lines, mcp_servers_of, read_work_config, save_mcp_servers } from "./cli_mcp_store.js";

function write_line(line: string): void {
  process.stdout.write(`${line}\n`);
}

function add_mcp_server(work_dir: string, name: string | undefined, flags: McpCliFlags): string {
  const server = require_server_name(name, "add");
  const current = read_work_config(work_dir);
  const servers = mcp_servers_of(current);
  if (servers[server] !== undefined) {
    throw new Error(`mcp server '${server}' already exists`);
  }
  servers[server] = build_mcp_entry(server, flags);
  save_mcp_servers(work_dir, current, servers);
  return `added ${server} disabled`;
}

export function run_mcp(work_dir: string, positionals: readonly string[], flags: McpCliFlags): number {
  const action = positionals[1];
  if (positionals.length > 3) {
    throw new Error("mcp takes one name");
  }
  if (action === "list") {
    if (positionals[2] !== undefined) {
      throw new Error("mcp list takes no name");
    }
    const lines = list_mcp_lines(mcp_servers_of(read_work_config(work_dir)));
    if (lines.length > 0) {
      process.stdout.write(`${lines.join("\n")}\n`);
    }
    return 0;
  }
  if (action === "add") {
    write_line(add_mcp_server(work_dir, positionals[2], flags));
    return 0;
  }
  if (action === "enable" || action === "disable") {
    write_line(set_mcp_enabled(work_dir, positionals[2], action === "enable"));
    return 0;
  }
  if (action === "remove") {
    write_line(remove_mcp_server(work_dir, positionals[2]));
    return 0;
  }
  throw new Error("mcp requires list, add, enable, disable, or remove");
}
