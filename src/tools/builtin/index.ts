import { disk_usage_tool } from "./disk_usage.js";
import { docs_read_tool, resolve_docs_root } from "./docs_read.js";
import { docs_search_tool } from "./docs_search.js";
import { edit_file_tool } from "./edit_file.js";
import { env_get_tool } from "./env_get.js";
import { fetch_url_tool } from "./fetch_url.js";
import { grep_files_tool } from "./grep_files.js";
import { http_request_tool } from "./http_request.js";
import { list_dir_tool } from "./list_dir.js";
import { process_list_tool } from "./process_list.js";
import { read_file_tool } from "./read_file.js";
import { run_tests_tool } from "./run_tests.js";
import { terminal_tool } from "./terminal.js";
import { web_search_tool } from "./web_search.js";
import { write_file_tool } from "./write_file.js";
import { logger } from "../../util/log.js";
import type { ToolRegistry } from "../registry.js";
import type { Tool, ToolContext, Toolset } from "../types.js";

const core_tools: Tool[] = [
  read_file_tool,
  write_file_tool,
  edit_file_tool,
  list_dir_tool,
  terminal_tool,
  grep_files_tool,
  fetch_url_tool,
  web_search_tool,
  http_request_tool,
  process_list_tool,
  disk_usage_tool,
  env_get_tool,
  run_tests_tool,
];

/** Docs tools register only when a docs root is resolvable for this process. */
function docs_tools(context: ToolContext): Tool[] {
  if (resolve_docs_root(context) === undefined) {
    logger.debug("docs tools skipped: no docs root (LICH_DOCS_DIR, work_dir/docs, or package docs)");
    return [];
  }
  return [docs_read_tool, docs_search_tool];
}

/** Assemble the builtin tool list; docs tools appear only when docs resolve. */
export function builtin_tools(context: ToolContext): Tool[] {
  return [...core_tools, ...docs_tools(context)];
}

export const builtin_toolset: Toolset = { name: "builtin", tools: core_tools };

/** Register every builtin tool onto a fresh registry (idempotent per registry). */
export function register_builtin_tools(registry: ToolRegistry, context?: ToolContext): void {
  const merged_context: ToolContext = context ?? {
    work_dir: process.cwd(),
    env: { LICH_DOCS_DIR: process.env["LICH_DOCS_DIR"] ?? "" },
  };
  registry.register_toolset({ name: "builtin", tools: builtin_tools(merged_context) });
}