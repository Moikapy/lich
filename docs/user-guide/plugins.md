# Plugins

> What you'll learn: how to extend lich with your own tools and lifecycle hooks — a quickstart, the full hook reference, tool authoring, blocking semantics, error isolation, naming rules, and security notes.

## What plugins are

A plugin is a plain TypeScript (or JavaScript) module you keep in your repo that exports a `Plugin` object: a unique `name`, optional `tools` to merge into the agent's registry, and optional `hooks` that observe (and can veto) tool calls and run lifecycle events. Plugins load at agent startup from explicit paths listed in your config — no installation step, no registry service, just files you control.

Plugins are inspired by [Hermes](https://github.com/NousResearch/Hermes-Function-calling) style customization: the harness stays small; your repo grows around it.

## Quickstart

Create the plugin module (defaults to `.lich/plugins/`, but any path works):

```ts
// .lich/plugins/my-plugin.ts
import type { Plugin } from "lich";

const my_plugin: Plugin = {
  name: "my-plugin",
  tools: [],
  hooks: {
    on_run_start: async (_info, ctx) => {
      console.log(`run starting in ${ctx.work_dir}`);
    },
  },
};

export default my_plugin;
```

Point your config at it and restart:

```json
{
  "providers": [ ... ],
  "plugins": ["./.lich/plugins/my-plugin.ts"]
}
```

Entry paths are relative to `work_dir` (or absolute). Restarting the agent reloads plugins — there is no hot reload.

## Hook reference

All hooks are awaited. Hook errors are logged as warnings and skipped — a broken hook never breaks the run.

| Hook | Signature | Purpose |
| --- | --- | --- |
| `before_tool_call` | `(info: {tool_name, args}, ctx) => {block?: boolean, reason?: string} \| void` | Runs before each tool call in plugin registration order. Return `{block: true, reason}` to veto. |
| `after_tool_call` | `(info: {tool_name, args, result_summary}, ctx) => void` | Runs after each tool call with a 300-char result summary. |
| `on_run_start` | `(info: {input_chars}, ctx) => void` | Runs once before the conversation loop starts. |
| `on_run_end` | `(info: {stopped_reason, turns_used}, ctx) => void` | Runs once after the loop ends with the outcome. |

`ctx` is `{work_dir: string}` — the agent's working directory.

## Tool authoring

Plugin tools implement the same `Tool` interface as builtins: a `name`, a `description` the model reads, a JSON Schema `parameters` object, and an async `execute(args, context)` returning `{ok, output, error?}`:

```ts
import type { Plugin, Tool } from "lich";

const upper_tool: Tool = {
  name: "upper_case",
  description: "Uppercase a short piece of text.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to uppercase" },
    },
    required: ["text"],
    additionalProperties: false,
  },
  execute: async (args, context) => {
    const text = typeof args.text === "string" ? args.text : "";
    return { ok: true, output: text.toUpperCase() };
  },
};

export const upper_case_plugin: Plugin = {
  name: "upper-case",
  tools: [upper_tool],
};
```

Guidelines:

- `name` must be unique across builtins and all plugins; duplicates are warned and skipped at registration.
- Keep `description` crisp — the model chooses tools from it.
- Tool failures return `{ok: false, error}` rather than throwing; the loop turns that into an error tool message the model can react to.

## before_tool_call blocking semantics

Hooks run in plugin registration order (config array order). The **first hook to return `{block: true}` wins**; later hooks do not run for that call and the real executor is never invoked. The model receives a tool message with error `blocked_by_plugin: <reason>` (or `blocked_by_plugin: plugin-less` when no reason is given) and can adapt, end the run, or try another approach. Non-blocking return values (including `undefined`) fall through to the next hook.

Blocking is observe-then-veto, not middleware: you cannot rewrite `args` or the result, only allow or veto. This keeps v1 semantics predictable.

## Error isolation

Failures are contained at every layer:

- **Broken import** (missing file, syntax error, missing export): the loader records the entry as an error, logs one warning with `plugin_errors_summary`, and starts the agent without that plugin.
- **Duplicate plugin names**: later duplicates become error entries; the first registration wins.
- **Throwing hook**: logged as a warning; the run continues as if the hook did not exist.
- **Throwing tool**: the executor captures it and returns `{ok: false, error}` to the loop.

## Naming rules

- `plugin.name` is required, must be a non-empty string, and must be unique per agent.
- Tool `name`s share one namespace with builtin tools — pick a prefix unique to your plugin (e.g. `mycorp_`).
- Entry modules must have a module extension (`.ts`, `.js`, `.mjs`, `.mts`, `.cts`, `.jsx`, `.tsx`).

## Runtime notes

- **Bun** runs TypeScript plugin files natively — `.ts` entries just work (`bun src/cli.ts ...`).
- **Node** (the built `dist/cli.js`) uses the native ESM loader, which does not compile TS. For node deployments, compile your plugin or ship it as `.mjs`/plain JS and list that file in `plugins`.

## Security note

Plugins execute **in-process with full privileges** — the same trust level as the agent itself and your shell. A plugin can read any file the process can, make network calls, and alter process state. Only load plugin files you wrote or audited; treat `.lich/plugins/` like you treat `.env` files.