# ⚱ lich

Lich is a TypeScript AI agent harness (library + CLI) that runs a
Think-Act-Observe loop: an LLM plans, calls tools, observes results, and
repeats until it produces a final answer. It ships with provider failover,
tool guardrails, context compression, and JSONL session persistence.

## Lore glossary

Lore names are prose only. Identifiers, config keys, event types, and tool
names do not change. The default system prompt is a myth-free behavior spec;
mythology lives in display strings only.

| Lore term | Actual concept | Where it appears |
| --- | --- | --- |
| **phylacteries** | JSONL session files in `.lich/sessions/` — conversations survive process death | This glossary; TUI `/sessions` listing label |
| **vessel-hopping** | Provider failover: 429/5xx retried with backoff, then the next provider takes over | This glossary |
| **the lair / wards** | `work_dir` confinement + `path_escape` guardrails for file tools. Wards do **not** apply to `terminal` or `run_tests` (shell still runs in `work_dir`; secret env names are scrubbed on spawn). | This glossary |
| **lair actions** | Plugin hooks that observe or veto tool calls | This glossary |
| **familiars** | Gateway adapters (webhook/telegram/discord/twitch) routing into one shared agent | This glossary |
| **spells** | Builtin tools in the registry | This glossary |
| **distillation** | Context compression: old turns summarized to fit the token budget | TUI compress notice |
| **the ritual is spent** | Turn-budget exhaustion | TUI + CLI budget notices |
| **dormant / deliberating / casting** | idle / thinking / tool phases | TUI status bar phase labels |
| **mortal** | The human user | TUI user transcript label |

## Documentation

| Page | Contents |
| --- | --- |
| [Docs home](docs/index.md) | Overview, feature map, and a 60-second quickstart. |
| [Getting started](docs/getting-started.md) | Zero-to-first-reply: install, config paths, one-shot, TUI, gateway. |
| [CLI reference](docs/user-guide/cli.md) | Modes, flags, provider resolution, config schema, `lich mcp`, recipes. |
| [TUI guide](docs/user-guide/tui.md) | Launch, slash commands, status bar, memory semantics. |
| [Gateway guide](docs/user-guide/gateway.md) | Webhook/Telegram/Discord/Twitch setup and the webhook API. |
| [Library guide](docs/user-guide/library.md) | Embedding: `create_agent`, events, multi-turn history, errors. |
| [Plugins guide](docs/user-guide/plugins.md) | User tools and hooks, and the self-improvement loop. |
| [Godot guide](docs/user-guide/godot.md) | The game connects to lich (webhook + `game_bridge`). |
| [Redot guide](docs/user-guide/redot.md) | lich connects to editor MCP servers. Redot is a catalog entry. |
| [Games guide](docs/user-guide/games.md) | Session JSONL as a combat log, and jq recipes over it. |
| [Persona example](examples/persona_orchestrator/README.md) | Per-NPC agents the game repo copies. Not a second core. |

## Quick start (CLI)

```sh
npm install -g @moikapy/lich
```

```sh
# one-shot task
LICH_MODEL=gpt-4.1-mini LICH_PROVIDER_KIND=openai_compat lich "summarize this repo"

# interactive chat (commands: /exit, /quit)
LICH_MODEL=claude-sonnet-4 LICH_PROVIDER_KIND=anthropic lich chat

# local ollama (no api key needed)
ollama pull llama3.2
LICH_PROVIDER_KIND=ollama LICH_MODEL=llama3.2 lich "hello"

# terminal UI
lich tui

# messaging gateway (webhook | telegram | discord | twitch)
lich gateway webhook
```

The CLI has four modes: **one-shot** (`lich "task"`), **chat**
(`lich chat`), **tui** (`lich tui`), and **gateway**
(`lich gateway <platform...>`). Other commands do not start an agent:
`lich init`, `lich config`, `lich update`, and `lich mcp`.

Or use a JSON config file: `lich --config lich.json "task"` (see
`AgentConfig` in `src/agent/config.ts` for the schema).

## Library usage

```ts
import { run_agent } from "@moikapy/lich";

const result = await run_agent(
  {
    providers: [
      { kind: "ollama", name: "local", model: "llama3.2:latest" },
    ],
  },
  "Use the list_dir tool to list files, then summarize.",
);
console.log(result.outcome.final?.content);
```

## Tools

Builtins ship with the agent (`register_builtin_tools`); all accept
snake_case args and are registered under the `builtin` toolset.
`git_commit` is registered by the gatekeeper, not by that list.

| Tool | Purpose |
| --- | --- |
| `read_file` | Read a text file inside the working directory, with optional offset/limit. |
| `write_file` | Write (or overwrite) a file inside the working directory. |
| `edit_file` | Replace a unique string in a file, with an optional replace-all. |
| `list_dir` | List a directory tree iteratively (dirs first, file sizes). |
| `terminal` | Run a shell command via `bash -lc` and capture output plus exit code. |
| `grep_files` | Regex search across files, skipping node_modules/.git/dist and binaries. |
| `fetch_url` | GET an http(s) URL and return the body text with a status header. |
| `web_search` | Web search via DuckDuckGo's HTML endpoint (no api key). |
| `http_request` | Generic HTTP calls (method/headers/body) for REST-ish APIs. |
| `process_list` | Snapshot running processes from /proc with an optional filter. |
| `disk_usage` | `du -sb` sizes for depth-1 entries of a directory, sorted with a total. |
| `env_get` | Inspect environment variables (names/lengths; secrets always masked). |
| `docs_read` | Read a bundled lich doc (path relative to docs root; offset/limit; `.md` optional). |
| `docs_search` | Keyword search across bundled lich docs and `.lich/skills/*.md`, with scored section snippets. |
| `run_tests` | Run `LICH_TEST_COMMAND` in the working directory and return a structured pass/fail. |

## Plugins

Customize lich with your own tools and lifecycle hooks: keep a `Plugin`
object (`{name, tools?, hooks?}`) in your repo, list its file path in the
`plugins` config array, and the agent merges your tools and lets your hooks
observe or veto tool calls. Bare `lich`, one-shot, chat, tui, and gateway
all load `config.plugins` (`create_agent_with_plugins`). `create_agent` does
not. See
[docs/user-guide/plugins.md](docs/user-guide/plugins.md).

Skills are markdown files you write to `.lich/skills/` with `write_file`;
`docs_search` finds them. They are reference data, not instructions.
`MEMORY.md` is append-only, never auto-loaded; review it between appends and
the next self-commit. One gated `git_commit` per run requires
`LICH_ALLOW_SELF_COMMIT=1` and a green `run_tests` on a clean tree.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `LICH_MODEL` | model name (e.g. `gpt-4.1-mini`, `claude-sonnet-4`, `llama3.2`) |
| `LICH_PROVIDER_KIND` | `openai_compat` \| `anthropic` \| `ollama` (default `openai_compat`) |
| `LICH_BASE_URL` | provider base url (ollama default: `http://localhost:11434`) |
| `LICH_API_KEY_ENV` | env var holding the api key (unused by ollama) |
| `LICH_ALLOW_SELF_COMMIT` | set to `1` to allow one gated `git_commit` per run; unset is fail-closed |
| `LICH_TEST_COMMAND` | command `run_tests` runs (default: `node node_modules/vitest/vitest.mjs run`) |

## Ollama

Ollama needs no api key and defaults to `http://localhost:11434`:

```sh
LICH_PROVIDER_KIND=ollama LICH_MODEL=llama3.2 lich "Reply with ok"
```

Notes:

- Requests go to `POST /api/chat` with `stream: false`; tool calls use the
  OpenAI-style function shape, and tool results are sent 1:1 as
  `{role: "tool", tool_name, content}` messages.
- Set `think: true` on the provider config (or chat options) to request
  thinking mode; `keep_alive` controls model residency (e.g. `"10m"`).
- 429/5xx are retried with backoff before failing over to the next provider.

## Gateway

`lich gateway` turns lich into a long-running messaging gateway: every
supported platform (Telegram, Discord, Twitch, plus a zero-config webhook
HTTP endpoint) is routed into **one shared agent** with **per-conversation
memory**, so each chat keeps its own bounded history while the tools,
guardrails, and provider failover stay common.

```sh
lich gateway webhook                 # http only
lich gateway webhook telegram        # http + telegram polling
lich gateway telegram discord twitch # no webhook server
```

Environment variables:

| Variable | Purpose |
| --- | --- |
| `LICH_GATEWAY_PORT` | webhook port (default `8089`) |
| `LICH_GATEWAY_TOKEN` | webhook auth: requests must send header `x-lich-token` |
| `LICH_TELEGRAM_BOT_TOKEN` | telegram bot token (adapter idles without it) |
| `LICH_DISCORD_BOT_TOKEN` | discord bot token (adapter idles without it) |
| `LICH_DISCORD_BOT_ID` | discord bot id; mentions of `<@id>` are stripped |
| `LICH_TWITCH_OAUTH_TOKEN` | twitch irc oauth token (adapter idles without it) |
| `LICH_TWITCH_NICK` | twitch irc nickname |
| `LICH_TWITCH_CHANNELS` | comma-separated twitch channels to join |

Adapters whose tokens are missing start **idle** (they log and skip) — the
gateway still runs the rest. The discord adapter has no reconnect-resume:
if its gateway websocket drops, messages are missed until the process
restarts.

Webhook API:

```sh
curl -X POST http://localhost:8089/message \
  -H "content-type: application/json" -d '{"text": "Reply with ok"}'
# -> {"reply":"...","usage":{...}}

curl http://localhost:8089/health    # -> {"status":"ok"}
```

## TUI

`lich tui` launches an ink-based terminal UI: a scrolling transcript with
tool-call rows, a status bar (model, turns, tokens), and a command input
row with Up/Down history recall (Ctrl+C quits).

```sh
lich tui
```

Slash commands: `/help`, `/model`, `/usage`, `/clear`, `/sessions`,
`/exit` (also `/quit`, `/q`). The transcript shows the newest 50 blocks.

## Themes

Display strings come from one active theme per process. Set `"theme": "lich"`
in `.lich/config.json`, or pass `--theme <name>`. The built-in `lich` theme
is frozen data: `~/.lich/themes/lich.json` is ignored. Any other name is read
from `~/.lich/themes/<name>.json`. A missing file, invalid JSON, or a file
that fails the theme schema logs one warning and falls back to `lich`. Themes
do not change the system prompt, tool descriptions, event types, or slash
command names.

The built-in tagline is `the agent that will not stay dead`, and it appears once, in the TUI banner (`welcome`). Greppable keywords
stay in place: budget notices still start with `budget exhausted`, and
compression notices still start with `context compressed`.

```json
{
  "name": "vampire",
  "agent_name": "vampire",
  "glyph": "🦇",
  "tagline": "night's clerk, unpaid",
  "welcome": "🦇 vampire v{version} — night's clerk, unpaid · {model} ({kind})",
  "goodbye": "dawn approaches",
  "response_label": "vampire",
  "user_label": "mortal",
  "phase_labels": { "idle": "sleeping", "thinking": "scheming", "tool": "feeding" },
  "notices": {
    "budget_exhausted": "budget exhausted — the blood bank is dry (turn cap reached)",
    "compressed": "context compressed — memories enthralled (summary {chars} chars)",
    "sessions": "coffins ({count}):"
  }
}
```

`welcome` substitutes `{version}`, `{model}`, and `{kind}`. `notices.compressed`
substitutes `{chars}`; `notices.sessions` substitutes `{count}`.

## Editor MCP

Two directions. lich connects **to** an editor MCP server (stdio local
command, or loopback HTTP). The game connects **to** lich through the webhook
and [`examples/game_bridge`](examples/game_bridge/README.md). Default is off.
`mcp_servers` is a closed record. Names are `mcp_<server>_<tool>`. `npx`,
`npm`, `bunx`, `uvx`, `curl`, `wget`, remote URLs, and shell metacharacters
are refused.

This source has `lich mcp list|add|enable|disable|remove` (changelog 0.7.0,
unreleased). The published npm package is 0.6.0 and does not include those
commands; `lich --version` still prints `0.6.0` because it reads
`package.json`. From a clone: `bun src/cli.ts mcp list`. Redot is a catalog
entry (`redot --headless --mcp-server`), not a fork inside lich. Godot has
no official MCP server; lich does not download a community addon. See
[docs/user-guide/redot.md](docs/user-guide/redot.md).

## Development

```sh
bun x tsc --noEmit                       # typecheck
node node_modules/vitest/vitest.mjs run  # tests (project-local binaries)
node node_modules/tsup/dist/cli-default.js src/index.ts src/cli.ts --format esm --dts --clean --sourcemap  # build
```

Use project-local binaries for vitest/tsup (not `bun x`), which would isolate
packages in /tmp and break dependency resolution.

## Releasing

```sh
bun release patch    # or minor | major
```

Fails closed on a dirty tree, a non-main branch, a typecheck error, or a
test failure; bumps via `npm version`, builds, and packs + audits
`test/.tmp/lich-<version>.tgz` (SHA-512 + scope verification) before
committing, tagging `v<version>`, and pushing main. Publishing stays manual
(`npm publish test/.tmp/lich-<version>.tgz`) so npm can prompt for the OTP.

## License

MIT