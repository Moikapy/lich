# Tools

Tools are how the model acts on the world. The contract is deliberately tiny:
a name, a description, a JSON Schema for arguments, and an async function that
**never throws**. Everything else - confinement, timeouts, clamping, error
shaping - is layered on top by the guard helpers and the executor.

## The tool interface contract

```ts
export interface ToolResult {
  ok: boolean;
  output: string;
  error?: string;
}

export interface ToolContext {
  work_dir: string;
  env: Record<string, string>;
  signal?: AbortSignal;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
```

(src/tools/types.ts)

**Never-throw convention.** `execute` resolves with a `ToolResult`; it reports
failure through `ok: false` plus an `error` string. Throwing is tolerated -
`capture_errors` wraps every builtin body and the executor catches the rest -
but the convention is to return, not throw, so callers get a well-shaped
result either way.

**`ToolContext`** gives each execution a working directory (`work_dir`, the
confinement root), a process environment map (the agent injects
`LICH_TERMINAL_TIMEOUT_MS`), and an optional abort `signal` the agent passes
from `Agent.run` so tools cancel on caller abort **or** the executor deadline
(`tool.timeout_ms`, else
`DEFAULT_TOOL_TIMEOUT_MS` = 30000). `terminal` sets 300000, `run_tests` sets
600000, and registered MCP tools set 120000. Note: `LICH_TERMINAL_TIMEOUT_MS`
is injected from config `terminal_timeout_ms` but the `terminal` tool ignores
it today — use the tool's `timeout_ms` argument (default 60000).

**Parameter schemas.** `parameters` is a `JsonSchemaObject`
(`src/util/json_schema.ts`) passed through verbatim into provider requests.
The wire-format keys (`properties`, `required`, `additionalProperties`) are a
**deliberate exemption** from the repo's snake_case convention, noted in the
source: these objects are serialized into LLM requests, so they must keep the
JSON Schema spelling.

## Guardrails deep dive

[`src/tools/guard.ts`](../../src/tools/guard.ts) holds the safety helpers
every builtin composes.

### `resolve_safe_path` - confinement math

```ts
export function resolve_safe_path(base_dir: string, target: string): string {
  const base = path.resolve(base_dir);
  const resolved = path.resolve(base, target);
  const relative = path.relative(base, resolved);
  if (relative.startsWith("..") === true || path.isAbsolute(relative) === true) {
    throw new Error(`path_escape: ${target} escapes ${base_dir}`);
  }
  return resolved;
}
```

(src/tools/guard.ts)

Both paths are resolved first (so symlinks are *not* the defense here - this
is lexical confinement), then `path.relative` computes the containment
relationship: escaping the base always produces a relative path starting with
`..`, and the absolute check catches edge cases such as different Windows
drive letters. Absolute targets are accepted as long as they land inside the
base. All filesystem builtins (`read_file`, `write_file`, `edit_file`,
`list_dir`, `grep_files`, `disk_usage`) confine through this function; the
error prefix `path_escape:` is the model-visible signal.

### `with_timeout` - deadline race

`with_timeout(promise_factory, timeout_ms, label)` builds its own
`AbortController`, races the factory's promise against a deadline promise, and
aborts the controller when the deadline fires. Key details:

- The factory receives the controller's signal, so long-running work (child
  processes, reads) can react to the deadline.
- The `setTimeout` handle is always cleared in a `finally`, so no timer leaks
  even when the work wins the race.
- Losing the race rejects with `ToolTimeoutError` (message:
  `timeout: <label> exceeded <n>ms`).
- The raced work promise gets a `.catch(() => undefined)` so a late failure
  does not surface as an unhandled rejection.

### Clamping and coercion

- `clamp_output(text, max_chars = 20000)` truncates via `truncate_text`,
  appending `[... truncated, N chars omitted ...]` - bounds on what a tool can
  pour into the context.
- Argument coercion helpers make malformed LLM args non-fatal:
  `require_string_arg` (throws `missing_arg: <key>`), `optional_string_arg`,
  `optional_number_arg`, `optional_boolean_arg` - each falls back on
  absent/empty/wrong-typed values.
- `is_enoent` detects Node fs ENOENT without subclass checks, and
  `error_result` / `capture_errors` convert any thrown value into
  `{ ok: false, output: "", error: message }`.

## Executor semantics

[`ToolExecutor`](../../src/tools/executor.ts) never throws. `execute(name,
args, context?)`:

1. **Unknown tool** -> error result, not an exception:
   `{ ok: false, output: "", error: "unknown_tool: <name>" }`. The model can
   read the message and self-correct.
2. **Default context** when none is passed: `work_dir` from the executor
   defaults (falling back to `process.cwd()`) plus the configured `env`.
3. **Cancelled fast path**: if the context signal is already aborted, return
   `{ ok: false, output: "", error: "cancelled" }` without running the tool.
4. **Signal merge + timeout**: a fresh `AbortController` is aborted by
   the external signal (an `abort` listener), by the `with_timeout` deadline
   (the tool's own `timeout_ms` when declared, else
   `DEFAULT_TOOL_TIMEOUT_MS = 30000`), and the merged signal is what the tool
   receives. The external listener is removed in a `finally`.
5. **Output clamping**: successful results pass through `clamp_result`
   (`clamp_output`, 20 000 chars).
6. **Failure shaping**: any throw (including `ToolTimeoutError`) lands in
   `failure_result`, which returns `error: "cancelled"` if the abort fired,
   else `error_result(err)`.

`ToolExecutor.format_result(result)` renders a result for a tool-role message:
**raw output on success, JSON on error**
(`{"ok":...,"output":...,"error":...}`). The loop mirrors this exact convention
in `format_tool_result_content` when building `ToolMessage`s (src/agent/loop.ts)
- the two stay in sync by convention, which is why the TUI can parse either
form back with `parse_tool_message_content` (src/tui/state.ts).

## Builtin catalog

Registered by `register_builtin_tools`
([`src/tools/builtin/index.ts`](../../src/tools/builtin/index.ts)).
Docs tools join the list only when a docs root resolves.

| Tool | Key args | Implementation insight |
| --- | --- | --- |
| `read_file` | `path`, `offset?`, `limit?` | 1-based line slicing, 256 KB clamp; ENOENT becomes `not_found:` error result, not a throw. |
| `write_file` | `path`, `content` | `mkdir` on the parent first, so new directories come for free; reports char count. |
| `edit_file` | `path`, `old_string`, `new_string`, `replace_all?` | Fails `old_string_not_found` / `old_string_not_unique (N)` unless `replace_all` - an exact-match protocol that forces the model to anchor edits. |
| `list_dir` | `path?`, `depth?` (1-4) | Iterative worklist (no recursion), dirs-first sorting, skips `node_modules`/`.git`/`dist`/`.lich`/`.cursor`, caps at 500 entries, file sizes via `stat`. |
| `terminal` | `command`, `timeout_ms?` | Spawns `bash -lc`, streams and caps stdout+stderr at 50 K chars, SIGKILLs on deadline, appends `[exit N]`; `ok` requires exit code 0 and no cancellation. |
| `grep_files` | `pattern`, `path?`, `glob?`, `max_results?` | Explicit stack walk (no recursion), skips `SKIP_DIRS` entries and symbolic links, per-file `assert_file_tool_access` check (`.lich/config.json` is denied), binary sniff (NUL byte in first 1000 bytes), 1 MB file cap, `*.ext` suffix-glob matcher, overcollect-by-one to report suppressed counts. |
| `fetch_url` | `url`, `max_chars?`, `timeout_ms?` | GET only; rejects non-http(s) protocols; refuses images/octet-stream; tags HTML bodies with `[html content]`; status/type header line first. |
| `web_search` | `query`, `max_results?` | Scrapes DuckDuckGo's HTML endpoint (no API key); unwraps `uddg=` redirect links; decodes the handful of entities DDG emits. |
| `http_request` | `url`, `method?`, `headers?`, `body?`, ... | Method allowlist (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS); stringified caller headers; reports `content-length`, `ratelimit-remaining`, `retry-after`. |
| `process_list` | `filter?`, `max_results?` | Reads `/proc` synchronously: numeric dirs are pids, `cmdline` is NUL-separated; missing entries (process died mid-scan) read as empty. |
| `disk_usage` | `path?`, `max_entries?` | One `du -sb` subprocess per depth-1 entry with a 10 s timeout; sorted desc with a `TOTAL` row; `du` missing yields `du_unavailable`. |
| `env_get` | `keys?`, `prefix?`, `reveal?` | Values are hidden unless `reveal`; names matching `/(secret\|token\|password\|key\|credential\|auth)/i` are **always** masked as `<redacted: N chars>`. |
| `run_tests` | `filter?` | Runs `LICH_TEST_COMMAND` (default `node node_modules/vitest/vitest.mjs run`) in `work_dir` via `bash -lc`. `timeout_ms` is 600000. A module mutex makes a concurrent call return `{ok:false, error:"run_tests_busy"}`. `ok` is the structured pass/fail the gatekeeper reads; output is clamped to 2000 chars. One lich process per repo — a second process is fail-closed busy or failed. |

The three HTTP tools (`fetch_url`, `web_search`, `http_request`) share
helpers from `fetch_url.ts`: `valid_http_url` (URL parse + protocol
allowlist), `compose_abort_signal` (per-call `AbortSignal.timeout` merged
with the executor's cancellation via `AbortSignal.any`), and `clamp_int_arg`
(floored, bounded to `[1, max]`).

`grep_files` also runs `assert_file_tool_access` on every candidate path
(the same deny list as `read_file`/`write_file`/`edit_file`): a direct
grep of `.lich/config.json` fails with `forbidden_path:
.lich/config.json`. During the walk, symbolic links are skipped on the
same branch as `SKIP_DIRS`, so symlink entries are neither followed nor
searched.

### HTTP tools and `safe_fetch` - pinned outbound requests

`fetch_url` and `http_request` send every request through `safe_fetch`
([`src/tools/url_guard.ts`](../../src/tools/url_guard.ts)). Per hop:

1. `resolve_public_ip` resolves the hostname and rejects private,
   loopback, link-local, and ULA addresses (`blocked_url:`), including
   `localhost` / `*.localhost` / `*.local` names.
2. The request is then issued with the **original hostname** kept for
   TLS/SNI and the `Host` header - the URL is not rewritten to the IP.
   The connect is pinned instead: a custom DNS `lookup` function handed
   to `http(s).request` returns only the already-vetted public IP.
3. Redirects are followed manually (`redirect: "manual"`) and every
   `Location` hop is re-resolved and re-vetted, up to 5 hops.

The operator opt-out is exact: `LICH_ALLOW_PRIVATE_URLS=1` allows
private targets (the value is compared to `"1"`), while unset or any
other value is fail-closed and private URLs stay blocked.

## Docs search and skills

`docs_search` scores sections under the resolved docs root (memoized) and, when
`<work_dir>/.lich/skills/` exists, also walks that directory. The skills
candidate is existence-only: it does not need `index.md`. The walk is fresh
on every call — user-writable skill files are not memoized into the package
docs cache. Skills are reference data, written with `write_file`, not
instructions. See the [plugins guide](../user-guide/plugins.md#skills-and-memory).

## Registry

[`ToolRegistry`](../../src/tools/registry.ts) is a name-keyed `Map`:

- **Duplicate rejection**: `register` throws
  `duplicate_tool: <name>` if the name exists - conflicting builtins fail
  loudly at startup instead of silently shadowing.
- **`definitions()`** maps each registered tool onto the provider-facing
  `ToolDefinition` shape (`name`, `description`, `parameters`).
- **`register_toolset`** registers a named group (`Toolset`) at once; the
  builtins ship as `builtin_toolset`.
- **Enabling a subset** is done by rebuilding a fresh registry: `Agent`'s
  `filter_registry` (src/agent/agent.ts) iterates `base.list()` and registers
  only allowed names onto a new `ToolRegistry` when `tools_enabled` is a list
  (`"all"` returns the base registry untouched). Plugin tools, including the
  gatekeeper's `git_commit`, register after that filter, so `tools_enabled: []`
  still leaves `git_commit`. MCP tools register later, on first `run()`, and
  only when the allowlist is `"all"` or names an `mcp_` tool.

For building your own tool, see [extending](./extending.md#add-a-builtin-tool).