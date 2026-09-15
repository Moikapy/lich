# Plugin architecture

How the plugin system loads user modules, merges tools into the registry, and intercepts tool calls with hooks. Sources: [`loader.ts`](../../src/plugins/loader.ts), [`hooks.ts`](../../src/plugins/hooks.ts), [`types.ts`](../../src/plugins/types.ts).

## Loader flow

`create_agent_with_plugins` parses the config, loads every entry from `config.plugins`, then hands `LoadedPlugin[]` to the `Agent` constructor. Each entry is resolved against `work_dir`, dynamically imported, and validated by shape; failures accumulate as error strings instead of throwing.

```mermaid
flowchart LR
    A["config.plugins entries"] --> B{"entry empty?"}
    B -- yes --> S["skip"]
    B -- no --> C["path.resolve(work_dir, entry)"]
    C --> D{"has module\nextension?"}
    D -- no --> E["error: plugin_entry_not_a_module"]
    D -- yes --> F["import(pathToFileURL(abs))"]
    F --> G{"import ok?"}
    G -- no --> H["error entry\n(import failure)"]
    G -- yes --> I{"shape: default /\nplugin export /\nmodule itself"}
    I -- none --> J["error: no plugin export"]
    I -- ok --> K{"name unique?"}
    K -- no --> L["error: duplicate_plugin_name"]
    K -- yes --> M["LoadedPlugin collected"]
    M --> N["Agent constructor"]
    N --> O["registry merge:\nplugin tools appended\n(dup tool name → warn+skip)"]
    N --> P["hook concat:\nPluginHooks[] in config order"]
    P --> Q["HookedToolRunner wraps\nToolExecutor when hooks exist"]
    E --> R["warn + continue"]
    H --> R
    J --> R
    L --> R
```

Three export shapes are accepted, checked in order: `default` export, a named `plugin` export, or the module object itself (top-level `name` plus `tools`/`hooks`). A bare object with just a `name` is rejected as a module-shape plugin (the `tools`/`hooks` surface must be present) to avoid treating arbitrary objects as plugins.

## HookedToolRunner interception

When any plugin provides hooks, `Agent` wraps the `ToolExecutor` in a `HookedToolRunner` and the loop's `ToolRunner` dependency points at the wrapper instead. The loop is unchanged — it still calls `execute(name, args, context)`.

```mermaid
sequenceDiagram
    participant L as loop (run_tool_calls)
    participant H as HookedToolRunner
    participant B as before_tool_call hooks
    participant E as ToolExecutor
    participant A as after_tool_call hooks

    L->>H: execute(name, args, context?)
    H->>B: await hook(info, ctx) in order
    B-->>H: {block: true, reason}?
    alt first blocker wins
        H-->>L: {ok: false, output: "", error: "blocked_by_plugin: reason"}
    else no blocker
        H->>E: execute(name, args, context?)
        E-->>H: ToolResult
        H->>A: await hook({...info, result_summary}, ctx)
        note over A: summary = 300 chars of output/error
        H-->>L: ToolResult unchanged
    end
```

Lifecycle fan-outs live on the same wrapper: `Agent.run` calls `call_run_start({input_chars})` before `run_conversation` and `call_run_end({stopped_reason, turns_used})` after it (including the abort/throw path, via `finally`). Both are best-effort: hook throws are logged at `warn` and the run proceeds.

## Design decisions

- **Explicit entries, no directory scan.** v1 loads only the files you list in `config.plugins`. Directory scanning would make runs depend on whatever happens to sit in a folder — non-reproducible, and a footgun for tools that write into `.lich/`. Explicit entries make the agent's tool surface a function of the config alone.
- **Observe-then-veto, not middleware.** `before_tool_call` may allow or veto but not rewrite args or results. Full middleware (argument rewriting, result transforms, ordering control) is a much larger design surface; v1 ships the 90% use case — guarding and auditing — with semantics simple enough to reason about: hooks run in config order and the first blocker wins.
- **Sync constructor + async factory.** `new Agent(config, plugins)` stays synchronous so existing callers and tests are untouched; the async work (dynamic imports) lives in `create_agent_with_plugins`. The trade-off: callers who construct `Agent` directly must load plugins themselves — documented in the library guide.
- **Errors as data.** The loader returns `{plugins, errors}` and `plugin_errors_summary` renders one warn line. Startup never crashes because one entry is broken, but misconfiguration is still visible in logs.

## Extension surface

| Export | Kind | Purpose |
| --- | --- | --- |
| `Plugin` | type | `{name, version?, tools?, hooks?}` — what a plugin module exports. |
| `PluginHooks` | type | The four optional lifecycle hooks with their signatures. |
| `HookContext` | type | `{work_dir}` passed to every hook. |
| `LoadedPlugin` | type | `{plugin, entry}` — a loaded plugin and its source path. |
| `load_plugins` | function | `(entries, base_dir) => {plugins, errors}` — dynamic import + shape validation. |
| `plugin_errors_summary` | function | Joins error entries into one warn-able string. |
| `HookedToolRunner` | class | Wraps any `{execute}` runner with before/after interception. |
| `create_agent_with_plugins` | function | Parse config → load plugins → build `Agent` (warns on errors). |
| `config.plugins` | config | `string[]` of entry module specifiers relative to `work_dir`. |

## Invariants

1. A bad plugin never crashes startup: import failures, missing exports, and duplicate names all become error entries.
2. Hooks and tools from later plugins cannot break earlier ones — every hook call is wrapped in try/catch with a `warn`.
3. Plugin tools cannot shadow builtin or other plugin tools: duplicate registration is a warn + skip, so the visible tool set is deterministic given a config.
4. The `ToolRunner` interface (`execute(name, args, context?)`) is structural — `HookedToolRunner` satisfies it without importing the loop.
5. No new dependencies: loading uses `import()` + `node:url`, registration uses the existing `ToolRegistry`.