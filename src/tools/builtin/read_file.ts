import { readFile } from "node:fs/promises";
import type { JsonSchemaObject } from "../../util/json_schema.js";
import {
  assert_file_tool_access,
  capture_errors,
  clamp_output,
  is_enoent,
  optional_number_arg,
  require_string_arg,
  resolve_safe_path,
} from "../guard.js";
import type { Tool } from "../types.js";

const MAX_READ_CHARS = 256000;

const parameters: JsonSchemaObject = {
  type: "object",
  properties: {
    path: { type: "string", description: "File to read, relative to the working directory" },
    offset: { type: "number", description: "1-based line number to start reading from" },
    limit: { type: "number", description: "Maximum number of lines to return" },
  },
  required: ["path"],
  additionalProperties: false,
};

function slice_lines(content: string, offset: number, limit: number): string {
  const lines = content.split("\n");
  const start = Math.max(0, offset - 1);
  return lines.slice(start, start + Math.max(0, limit)).join("\n");
}

async function read_target(args: Record<string, unknown>, work_dir: string, target: string): Promise<string> {
  const file_path = resolve_safe_path(work_dir, target);
  assert_file_tool_access(work_dir, file_path, "read");
  const content = await readFile(file_path, "utf8");
  const offset = optional_number_arg(args, "offset", 1);
  const limit = optional_number_arg(args, "limit", Number.MAX_SAFE_INTEGER);
  return clamp_output(slice_lines(content, offset, limit), MAX_READ_CHARS);
}

export const read_file_tool: Tool = {
  name: "read_file",
  description: "Read a UTF-8 text file, optionally starting at a 1-based line offset with a line limit.",
  parameters,
  execute: async (args, context) =>
    capture_errors(async () => {
      const target = require_string_arg(args, "path");
      try {
        const output = await read_target(args, context.work_dir, target);
        return { ok: true, output };
      } catch (err) {
        if (is_enoent(err) === true) {
          return { ok: false, output: "", error: `not_found: ${target}` };
        }
        throw err;
      }
    }),
};
