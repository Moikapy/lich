/**
 * Read and update work-dir mcp_servers through write_lich_config.
 * Never prints env values.
 */
import { existsSync } from "node:fs";
import { load_config, project_config_path, write_lich_config } from "./cli_config.js";

export function read_work_config(work_dir: string): Record<string, unknown> {
  const file = project_config_path(work_dir);
  if (existsSync(file) === false) {
    return {};
  }
  return load_config(file) ?? {};
}

export function mcp_servers_of(config: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const raw = config["mcp_servers"];
  if (raw === undefined) {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) === true) {
    throw new Error("mcp_servers must be an object");
  }
  const servers: Record<string, Record<string, unknown>> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry) === true) {
      throw new Error(`mcp server '${name}' is not an object`);
    }
    servers[name] = { ...entry };
  }
  return servers;
}

export function save_mcp_servers(
  work_dir: string,
  current: Record<string, unknown>,
  servers: Record<string, Record<string, unknown>>,
): void {
  const next: Record<string, unknown> = { ...current };
  if (Object.keys(servers).length === 0) {
    delete next["mcp_servers"];
  } else {
    next["mcp_servers"] = servers;
  }
  const result = write_lich_config(work_dir, next, true);
  if (result.written !== true) {
    throw new Error("mcp config was not written");
  }
}

export function list_mcp_lines(servers: Record<string, Record<string, unknown>>): string[] {
  const lines: string[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    const transport = typeof entry["url"] === "string" ? "http" : "stdio";
    const enabled = entry["enabled"] === true ? "true" : "false";
    lines.push(`${name} ${transport} ${enabled}`);
  }
  return lines;
}
