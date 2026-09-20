import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonSchemaObject } from "../../util/json_schema.js";
import { assert_file_tool_access, capture_errors, require_string_arg, resolve_safe_path } from "../guard.js";
import type { Tool } from "../types.js";

const parameters: JsonSchemaObject = {
  type: "object",
  properties: {
    path: { type: "string", description: "File to write, relative to the working directory" },
    content: { type: "string", description: "Full content to write (overwrites existing file)" },
  },
  required: ["path", "content"],
  additionalProperties: false,
};

function read_content_arg(args: Record<string, unknown>): string {
  const content = args.content;
  if (typeof content !== "string") {
    throw new Error("missing_arg: content");
  }
  return content;
}

async function write_target(work_dir: string, target: string, content: string): Promise<string> {
  const file_path = resolve_safe_path(work_dir, target, true);
  assert_file_tool_access(work_dir, file_path, "write");
  await mkdir(path.dirname(file_path), { recursive: true });
  await writeFile(file_path, content, "utf8");
  return `wrote ${content.length} chars to ${target}`;
}

export const write_file_tool: Tool = {
  name: "write_file",
  description: "Write (or overwrite) a UTF-8 text file, creating parent directories as needed.",
  parameters,
  execute: async (args, context) =>
    capture_errors(async () => {
      const target = require_string_arg(args, "path");
      const content = read_content_arg(args);
      const output = await write_target(context.work_dir, target, content);
      return { ok: true, output };
    }),
};
