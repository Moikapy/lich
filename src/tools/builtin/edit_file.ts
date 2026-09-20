import { readFile, writeFile } from "node:fs/promises";
import type { JsonSchemaObject } from "../../util/json_schema.js";
import {
  assert_file_tool_access,
  capture_errors,
  is_enoent,
  optional_boolean_arg,
  require_string_arg,
  resolve_safe_path,
} from "../guard.js";
import type { Tool } from "../types.js";

const parameters: JsonSchemaObject = {
  type: "object",
  properties: {
    path: { type: "string", description: "File to edit, relative to the working directory" },
    old_string: { type: "string", description: "Exact text to replace (must be unique unless replace_all)" },
    new_string: { type: "string", description: "Replacement text" },
    replace_all: { type: "boolean", description: "Replace every occurrence instead of failing on multiples" },
  },
  required: ["path", "old_string", "new_string"],
  additionalProperties: false,
};

function count_occurrences(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

function replacement_for(content: string, old_string: string, new_string: string, replace_all: boolean): string {
  if (replace_all === true) {
    return content.split(old_string).join(new_string);
  }
  return content.replace(old_string, new_string);
}

async function apply_edit(
  work_dir: string,
  target: string,
  old_string: string,
  new_string: string,
  replace_all: boolean,
): Promise<{ output: string; replaced: number }> {
  const file_path = resolve_safe_path(work_dir, target, true);
  assert_file_tool_access(work_dir, file_path, "write");
  let content: string;
  try {
    content = await readFile(file_path, "utf8");
  } catch (err) {
    if (is_enoent(err) === true) {
      throw new Error(`not_found: ${target}`);
    }
    throw err;
  }
  const occurrences = count_occurrences(content, old_string);
  if (occurrences === 0) {
    throw new Error("old_string_not_found");
  }
  if (occurrences > 1 && replace_all === false) {
    throw new Error(`old_string_not_unique (${occurrences} occurrences)`);
  }
  const updated = replacement_for(content, old_string, new_string, replace_all);
  await writeFile(file_path, updated, "utf8");
  const replaced = replace_all === true ? occurrences : 1;
  return { output: `edited ${target} (replaced ${replaced} occurrence(s))`, replaced };
}

export const edit_file_tool: Tool = {
  name: "edit_file",
  description: "Replace an exact string in a text file; fails on missing or non-unique matches unless replace_all.",
  parameters,
  execute: async (args, context) =>
    capture_errors(async () => {
      const target = require_string_arg(args, "path");
      const old_string = require_string_arg(args, "old_string");
      const new_string = require_string_arg(args, "new_string");
      const replace_all = optional_boolean_arg(args, "replace_all", false);
      const result = await apply_edit(context.work_dir, target, old_string, new_string, replace_all);
      return { ok: true, output: result.output };
    }),
};
