/**
 * Fixture plugin for the plugin test suite: a tiny echo tool plus a
 * before_tool_call hook that vetoes the fake "blocked_tool" name.
 */
import type { JsonSchemaObject } from "../../../src/util/json_schema.js";
import type { Tool } from "../../../src/tools/types.js";
import type { BeforeToolCallResult, Plugin } from "../../../src/plugins/types.js";

const echo_parameters: JsonSchemaObject = {
  type: "object",
  properties: {
    text: { type: "string", description: "Text to echo back" },
  },
  required: ["text"],
  additionalProperties: false,
};

const echo_tool: Tool = {
  name: "plugin_echo",
  description: "Echo the given text back, prefixed for the test.",
  parameters: echo_parameters,
  execute: async (args) => {
    const text = typeof args.text === "string" ? args.text : "";
    return { ok: true, output: `plugin_echo: ${text}` };
  },
};

const good_plugin: Plugin = {
  name: "good",
  version: "1.0.0",
  tools: [echo_tool],
  hooks: {
    before_tool_call: async (info): Promise<BeforeToolCallResult | void> => {
      if (info.tool_name === "blocked_tool") {
        return { block: true, reason: "nope" };
      }
    },
  },
};

export default good_plugin;