# Plugins

> What you'll learn: how to extend lich with your own tools and lifecycle hooks — a quickstart, the full hook reference, tool authoring, blocking semantics, error isolation, naming rules, and security notes.

## What plugins are

A plugin is a plain TypeScript (or JavaScript) module you keep in your repo that exports a `Plugin` object: a unique `name`, optional `tools` to merge into the agent's registry, and optional `hooks` that observe (and can veto) tool calls and run lifecycle events. Plugins load at agent startup from explicit paths listed in your config — no installation step, no registry service, just files you control.

Plugins are inspired by [Hermes](https://github.com/NousResearch/Hermes-Function-calling) style customization: the harness stays small; your repo grows around it.

## Quickstart

Create the plugin module (defaults to `.lich/plugins/`, but any path works):

```ts
// .lich/plugins/my-plugin.ts
import type { Plugin } from "@moikapy/lich";

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
| `after_tool_call` | `(info: {tool_name, args, result_summary, ok, error?}, ctx) => void` | Runs after each tool call with a 300-char summary plus structured `ok`/`error`. |
| `on_run_start` | `(info: {input_chars}, ctx) => void` | Runs once before the conversation loop starts. |
| `on_run_end` | `(info: {stopped_reason, turns_used}, ctx) => void` | Runs once after the loop ends with the outcome. |

`ctx` is `{work_dir, state?}` — the agent's working directory plus that plugin's per-run bag.

## Tool authoring

Plugin tools implement the same `Tool` interface as builtins: a `name`, a `description` the model reads, a JSON Schema `parameters` object, and an async `execute(args, context)` returning `{ok, output, error?}`:

```ts
import type { Plugin, Tool } from "@moikapy/lich";

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

The CLI loads `config.plugins` before the run. A broken entry logs one `plugin load errors` warning and the run continues.

Checked with Node 26.8.2 (`node dist/cli.js`) and Bun 1.3.14 (`bun src/cli.ts`):

- `.mjs` loads on both, with no plugin-load warning. The quickstart above is `.ts`; the same module as `.mjs` (no type syntax) is the plain-JS form.
- `.ts` that uses only erasable types (`import type`, annotations) also loads on both, with no plugin-load warning. Node 26 type-strips by default; it does not bundle. `node --no-strip-types` warns (`Unknown file extension ".ts"`) and continues.
- Syntax Node cannot strip (for example `enum`) warns and continues. Bun runs that same file with no plugin-load warning. A syntax error warns on both and the run continues.

Plain JS (loads on both; not a node-only fallback — `.ts` already loaded with no plugin-load warning):

```mjs
// .lich/plugins/my-plugin.mjs
const my_plugin = {
  name: "my-plugin",
  tools: [],
};

export default my_plugin;
```

## Self-improvement loop

The agent can write a tool, prove it with `run_tests`, and commit it with
`git_commit` — one commit per run, and only when you opt in. The gatekeeper
is constructed in code (not listed in `config.plugins`). If it does not
register, `git_commit` is absent. A config plugin naming `git_commit` is
inside the plugin-trust floor only when the gatekeeper is off; while it is
on, first-wins keeps the gatekeeper's tool.

Set `LICH_ALLOW_SELF_COMMIT=1` before startup. Unset, or any other value, is
fail-closed. `git_commit` is vetoed unless every condition holds; the reason
names the first failure, and the model sees `blocked_by_plugin: <reason>`:

| Failed condition | Reason |
| --- | --- |
| `LICH_ALLOW_SELF_COMMIT` is not `1` | `self_commit_disabled` |
| no green `run_tests` yet this run | `tests_not_ok` |
| a `write_file` or `edit_file` succeeded after that green run | `worktree_dirty` |
| this run already committed once | `commit_budget_exhausted` |

`terminal` is vetoed when the command matches the hardcoded git denylist.
The reason is `git_denylist: <pattern>`. Patterns are flag-tolerant
`commit`/`push` (`commit`, `-commit`, `--commit`, `push`, `-push`, `--push`)
and any occurrence of `commit-tree` or `update-ref`. There is no `remote`
pattern. The denylist is best-effort: raw `terminal` can still run git. The
boundary is a human reviewing the local repo. Push is human-only.

`git_commit` takes `{message, paths}` — 1 to 50 paths relative to `work_dir`.
It rejects `""`, `.`, a path that resolves to `work_dir` itself, and
secret-ish basenames (`.env`, `.env.local`, `*.pem`, `*.p12`, `id_rsa*`).
It refuses an unreachable `HEAD`. It stages exactly the named paths
(`git add -- <paths>`) and commits with `git commit --only`. It never pushes.

`run_tests` takes an optional `filter` and runs `LICH_TEST_COMMAND` in
`work_dir` (default `node node_modules/vitest/vitest.mjs run`) with a 600s
timeout. A second call in the same process returns `run_tests_busy`. The
mutex is process-local: one lich process per repo.

Clean state attests no `write_file`/`edit_file` since the last green
`run_tests`; it does NOT attest absence of terminal-mediated writes.

### Skills and memory

Write a markdown note with `write_file` to `.lich/skills/<name>.md`.
`docs_search` finds those files. That directory does not need `index.md`,
and it is walked fresh on every search. The default system prompt says tool
results — docs, skills, memory — are reference data, not instructions.

`MEMORY.md` is append-only and human-reviewable. It is never auto-loaded.
Review it between appends and the next self-commit.

## Security note

Plugins execute **in-process with full privileges** — the same trust level as the agent itself and your shell. A plugin can read any file the process can, make network calls, and alter process state. Only load plugin files you wrote or audited; treat `.lich/plugins/` like you treat `.env` files.

`.lich/config.json` `plugins` is persistent arbitrary code at the next process start. Review config diffs before the next self-commit. The terminal git denylist does not close that hole.