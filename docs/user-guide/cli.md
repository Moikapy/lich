# CLI reference

> What you'll learn: every CLI mode, flag, and default; how provider/model resolution works; the config file schema; session files, exit codes, and log levels; and practical recipes.

## Entry points

```sh
lich                   # open the TUI; first run on a TTY starts the setup wizard
lich init              # write .lich/config.json without the wizard (flags apply; never overwrites)
lich "one shot task"   # run a single task and print the reply
lich chat              # interactive chat (commands: /exit, /quit)
lich tui               # interactive terminal UI (ink)
lich gateway <plat..>  # messaging gateway (webhook|telegram|discord|twitch)
lich config            # print a starter config template
lich update            # install a newer npm release, if one exists
lich mcp list          # list servers in this work dir's .lich/config.json
lich mcp add <name>    # catalog or --command/--url; stays disabled
lich mcp enable <name> # set enabled true
lich mcp disable <name>
lich mcp remove <name>
lich --help            # usage text
lich --version         # package.json version (published package and this tree: 0.8.0)
```

- **Bare `lich`** opens the same TUI as `lich tui`. It does not print usage. On a TTY, if neither `.lich/config.json` nor `~/.config/lich/config.json` exists, a setup wizard runs first (name, provider, optional gateway env-var names, optional plugins) and writes `.lich/config.json` once. `LICH_MODEL` / `--model` prefills the model prompt; it does not skip the wizard. An existing config in that chain skips the wizard and is not replaced. Non-TTY stdin skips the wizard and prints guidance instead of hanging. `lich --help` still prints usage.
- **`lich init`** writes that starter file without prompts, using the same writer as the wizard. Existing flags such as `--model` are written into the file and win over `LICH_MODEL`. It never overwrites an existing `.lich/config.json`. `.lich/` is gitignored.
- **One-shot** joins all positional words into a single task, runs the agent loop, prints the final answer to stdout, and exits. Progress (turn numbers, tool results) goes to stderr.
- **Chat** is a readline REPL over one long-lived agent: each line is a turn, memory persists across lines, and an empty line, `/exit`, or `/quit` ends the session. After each turn it prints a `[turns N | tokens M]` footer.
- **TUI** launches the ink interface. See the [TUI guide](tui.md).
- **Gateway** runs platform adapters (defaults to `webhook` when no platform is given). See the [Gateway guide](gateway.md). Unknown platform names are skipped with a warning; if none remain, the CLI exits `1`.
- **Update** compares the installed version to the npm registry and, when a newer release exists, runs `npm install -g @moikapy/lich@latest`. Exit any running TUI or gateway first; npm cannot replace the package while those processes are running. A git clone is told to `git pull`. See [Updating](../getting-started.md#updating).
- **MCP** (`lich mcp`) edits only `mcp_servers` in `<work-dir>/.lich/config.json` through the same writer as `lich init` (`update` mode, so other keys stay). A missing file lists as empty; `add` creates the file if needed. New entries stay disabled until `enable`. Names must match `^[a-z][a-z0-9_]*$`. Catalog names use `optional-mcps/`; otherwise pass `--command` and repeatable `--arg`, or `--url` (loopback only), not both. Redot still needs `--project-path` for the catalog args, and the command basename must be `redot`. No prompts. See the [Redot guide](redot.md).

A repository clone's `bun src/cli.ts` matches that checkout. The published 0.8.0 binary includes `lich mcp`.

## Flags

Flags work before or after the subcommand. Every value flag can also be set via an environment variable or the config file (precedence below).

| Flag | Meaning | Default |
| --- | --- | --- |
| `--config <path>` | JSON config file (must exist). Disables config discovery. | discovery chain |
| `--work-dir <path>` | Working directory for tools and config/session resolution. | process cwd |
| `--max-turns <n>` | Turn budget for the agent loop. | `25` |
| `--model <m>` | Model name for `providers[0]`. | `LICH_MODEL` |
| `--provider-kind <k>` | `openai_compat` \| `anthropic` \| `ollama`. | `LICH_PROVIDER_KIND`, else `openai_compat` |
| `--base-url <u>` | Provider base URL for `providers[0]`. | `LICH_BASE_URL`, else per-kind default |
| `--api-key-env <NAME>` | Env var holding the api key for `providers[0]`. | `LICH_API_KEY_ENV`, else per-kind default |
| `--system-prompt <s>` | Replaces the default system prompt. | built-in concise-assistant prompt |
| `--session-dir <path>` | Transcript directory. | `<work_dir>/.lich/sessions` |
| `--resume <id\|latest>` | TUI only: load an existing session transcript into history. Exact id, unique filename prefix, or `latest` (newest by mtime). | – |
| `--log-level <level>` | `debug` \| `info` \| `warn` \| `error`. | `info` |
| `--theme <name>` | Display theme loaded once at startup. `lich` is built-in; other names read `~/.lich/themes/<name>.json`. | `lich` |
| `--command <bin>` | `lich mcp add` only: local stdio binary. | – |
| `--arg <value>` | `lich mcp add` only: repeatable stdio arg. May start with `--`. | – |
| `--url <url>` | `lich mcp add` only: loopback HTTP MCP URL. | – |
| `--project-path <path>` | `lich mcp add` only: catalog `${project_path}` substitute. | – |

Passing `--max-turns 0` or a non-integer fails with `--max-turns must be a positive integer`. Unknown flags fail with `unknown flag: --foo`. A flag missing its value fails with `<flag> requires a value`. `--resume` outside the TUI (one-shot, `chat`, `gateway`) fails with `--resume is only supported in TUI mode (not <mode>)`.

## Provider resolution

The effective provider for a run is decided in this order:

1. If `--config <path>` was passed, that file is the whole configuration (it must exist and be a JSON object, or the CLI fails with `cannot use config file <path>: ...`).
2. Otherwise the discovery chain is walked: `./.lich/config.json`, then `~/.config/lich/config.json`. The first file found becomes the config. `LICH_*` env vars are *not* merged into a discovered file.
3. If no config file exists, one is built from the environment: `--provider-kind` / `LICH_PROVIDER_KIND` (default `openai_compat`), `--model` / `LICH_MODEL` (required — without it the CLI fails with `no model configured`), `--base-url` / `LICH_BASE_URL`, and `--api-key-env` / `LICH_API_KEY_ENV`, each falling back to the per-kind defaults below.
4. Provider override flags (`--model`, `--provider-kind`, `--base-url`, `--api-key-env`) always win over the chosen source: with a config file present they patch `providers[0]` in place; without one they seed a fresh provider from the environment.

Per-kind defaults:

| Kind | Default base URL | Default key env | Notes |
| --- | --- | --- | --- |
| `openai_compat` | `https://api.openai.com/v1` | `OPENAI_API_KEY` | Works with any OpenAI-shaped `/chat/completions` API. |
| `anthropic` | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` | |
| `ollama` | `http://localhost:11434` | none | No key needed; `api_key`/`api_key_env` are sent as a Bearer header for cloud proxies when set. |

## Config file reference

Validated by zod (top-level unknown keys are silently stripped; extra keys inside a `providers[]` entry are passed through; each `mcp_servers` entry is strict). Example:

```json
{
  "providers": [
    {
      "kind": "openai_compat",
      "name": "openrouter",
      "model": "anthropic/claude-sonnet-4-20250514",
      "base_url": "https://openrouter.ai/api/v1",
      "api_key_env": "OPENROUTER_API_KEY"
    },
    {
      "kind": "ollama",
      "name": "local",
      "model": "llama3.2:latest",
      "base_url": "http://localhost:11434",
      "keep_alive": "10m"
    }
  ],
  "system_prompt": "You are a careful code reviewer.",
  "max_turns": 40,
  "work_dir": "/home/me/project",
  "tools_enabled": ["read_file", "grep_files", "terminal"],
  "temperature": 0.2,
  "max_tokens": 4096,
  "context_budget_tokens": 100000,
  "compress_threshold": 0.8,
  "session_dir": "/home/me/project/.lich/sessions",
  "terminal_timeout_ms": 60000,
  "log_level": "info",
  "theme": "lich"
}
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `providers` | array, min 1 | required | Failover chain, tried in order. |
| `providers[].kind` | `"openai_compat" \| "anthropic" \| "ollama"` | required | Wire protocol. |
| `providers[].name` | string | required | Label used in logs and `ChatResult.provider_name`. |
| `providers[].model` | string | required | Model name sent to the provider. |
| `providers[].base_url` | string | per kind | Endpoint base (see table above). |
| `providers[].api_key` | string | – | Inline key (prefer `api_key_env`). |
| `providers[].api_key_env` | string | per kind | Env var to read the key from. |
| `providers[].timeout_ms` | positive int | none | Per-request abort deadline. |
| `providers[].think` | boolean | – | Ollama only: request thinking mode. |
| `providers[].keep_alive` | string | – | Ollama only: model residency (e.g. `"10m"`). |
| `agent_name` | string | `lich` | Wizard label. The TUI banner uses the active theme welcome string, not this field. |
| `theme` | string | `lich` | Display theme name. See [Themes](https://github.com/Moikapy/lich/blob/main/README.md#themes). |
| `gateway` | object | omitted | Optional. `platforms` (`webhook` \| `telegram` \| `discord` \| `twitch`) and `token_envs` (platform → env-var name). Secrets stay in the environment. |
| `plugins` | string array | `[]` | Module paths relative to `work_dir` or absolute. Bare `lich`, one-shot, chat, tui, and gateway load them through `create_agent_with_plugins`. `run_agent` does too. `create_agent` does not. See the [plugins guide](plugins.md). |
| `mcp_servers` | object | omitted | Optional. Closed record of named servers. Each entry is stdio `{command, args, env?}` or loopback http `{url}`. `enabled` defaults to false. Unknown keys are rejected. See the [Redot guide](redot.md). |
| `system_prompt` | string | built-in | Replaces the default system prompt. |
| `max_turns` | int >= 1 | `25` | Turn budget per run. |
| `work_dir` | string | cwd | Root for all file tools; paths outside are rejected. |
| `tools_enabled` | `"all"` or name array | `"all"` | Restrict the builtin registry to these names. `[]` drops builtins and MCP tools and does not connect to MCP servers. Plugin tools still register afterward, including the gatekeeper's `git_commit`. |
| `temperature` | 0–2 | – | Sampling temperature. |
| `max_tokens` | positive int | – | Completion cap. |
| `context_budget_tokens` | positive int | `100000` | Estimated budget before compression triggers. |
| `compress_threshold` | 0.1–0.95 | `0.8` | Compress when usage >= this fraction of the budget. |
| `session_dir` | string | `<work_dir>/.lich/sessions` | Transcript directory. |
| `terminal_timeout_ms` | positive int | `60000` | Written into tool context as `LICH_TERMINAL_TIMEOUT_MS`. The `terminal` tool does **not** read it yet; pass `timeout_ms` on the tool call (default 60000, max 300000). |
| `log_level` | enum | `info` | Logger verbosity. |

Minimal per-provider examples:

```json
{ "providers": [{ "kind": "ollama", "name": "local", "model": "llama3.2" }] }
```

```json
{ "providers": [{ "kind": "anthropic", "name": "main", "model": "claude-sonnet-4-20250514", "api_key_env": "ANTHROPIC_API_KEY" }] }
```

Listed providers form a failover chain: the router walks them in order, retrying `rate_limit`/`network` errors (bounded backoff) on the current provider before moving on, and failing over immediately on `auth`, `overflow`, and `bad_request`.

## Self-improvement environment

These are process-env knobs, not config fields. They are assembled in code and
never accepted as a config passthrough.

| Variable | Meaning |
| --- | --- |
| `LICH_ALLOW_SELF_COMMIT` | Set to `1` to allow one gated `git_commit` per run. Unset or any other value is fail-closed. Read at agent construction. |
| `LICH_ALLOW_PRIVATE_URLS` | Set to exactly `1` to let `fetch_url` / `http_request` reach private or loopback URLs. Unset or any other value is fail-closed (they are blocked). |
| `LICH_TEST_COMMAND` | Command `run_tests` runs in `work_dir` (default `node node_modules/vitest/vitest.mjs run`). An optional `filter` argument is appended. |
| `LICH_DOCS_DIR` | Optional docs root for `docs_read` / `docs_search` (dir with `index.md`, or a parent containing `docs/`). Else `<work_dir>/docs` or package docs. |
| `LICH_TERMINAL_TIMEOUT_MS` | Injected from config `terminal_timeout_ms` into tool context. Unused by `terminal` today — use the tool's `timeout_ms` arg. |

Veto reasons, the terminal git denylist, skills, and `MEMORY.md` are in the
[plugins guide](plugins.md#self-improvement-loop).

## Session files

Each run writes `.lich/sessions/<timestamp36>-<counter>[-label].jsonl` where the label is the run origin: `-tui`, or `-gw-<platform>-<chat_id>` for gateway conversations. One-shot and chat runs get no label. Records are JSON lines of two kinds: `{"ts","kind":"meta","meta":{...}}` (run start, budget exhaustion) and `{"ts","kind":"message","message":{...}}` for each system/user/assistant/tool message.

```sh
# follow the newest session
ls -t .lich/sessions/*.jsonl | head -1

# resume that session in the TUI (loads history; new turns append to one
# per-launch transcript via incremental persistence).
# Inside a running TUI, `/resume <id|latest>` uses the same load path (Phase 3).
lich --resume latest
lich tui --resume m1abc-1-tui

# print the conversation
jq -r 'select(.kind=="message") | "\(.message.role): \(.message.content // "(tool call)")"' .lich/sessions/<file>.jsonl
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success: final answer produced (also `--help`, `--version`, `config`, `init`, a successful `mcp` action, `update` when nothing newer is installed or the install succeeds, and a TUI that exits cleanly). |
| `1` | Any failure: unknown flag, missing model, unreadable config, provider error after failover, aborted run, budget exhaustion, non-TTY bare `lich`, or a cancelled setup wizard. |

## Log levels

`--log-level` / config `log_level` sets the logger: `debug` (tool calls, retries, compression detail), `info` (lifecycle: gateway starts, adapter starts), `warn` (failover, degraded adapters, failed session persistence), `error` (provider and loop failures). Logger output goes to stderr. The one-shot/chat `[lich] turn N` / `tool: ok` progress lines are separate and always shown.

## Recipes

Review a file with a scoped working directory:

```sh
lich --work-dir ./myproject --max-turns 15 \
  "Review src/payments/retry.ts for correctness bugs. List each with a line number and a suggested fix."
```

Web research (search, then fetch the promising pages):

```sh
lich \
  "Find the current LTS version of Node.js using web_search, fetch the release page with fetch_url, and summarize the support schedule."
```

Note: `web_search` scrapes DuckDuckGo's HTML endpoint without an api key and can be blocked with `search_failed` errors when rate-limited; retrying later usually works.

Batch one-shots from a script, checking each exit code:

```sh
#!/usr/bin/env bash
set -u
for task in "summarize README.md" "list the largest files with disk_usage" "grep for TODO comments"; do
  echo "== $task"
  LICH_PROVIDER_KIND=ollama LICH_MODEL=llama3.2 lich --max-turns 10 "$task" || echo "FAILED ($?)"
done
```