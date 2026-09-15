/**
 * Fixture plugin whose module object itself is the plugin (loader shape test):
 * exports name/tools/hooks directly with no default or `plugin` export.
 */
import type { Tool } from "../../../src/tools/types.js";
import type { JsonSchemaObject } from "../../../src/util/json_schema.js";
import type { Plugin } from "../../../src/plugins/types.js";

const noop_parameters: JsonSchemaObject = { type: "object" };

const noop_tool: Tool = {
  name: "module_noop",
  description: "A no-op plugin tool from the module-shape fixture.",
  parameters: noop_parameters,
  execute: async () => ({ ok: true, output: "module_noop done" }),
};

const module_hooks = {
  after_tool_call: async () => undefined,
};

export const name = "module";
export const hooks = module_hooks;
export const tools = [noop_tool];