# Getting started

> What you'll learn: how to install Lich, configure a provider three different ways, and get your first reply through the one-shot CLI, the TUI, and the gateway webhook.

## Prerequisites

- Node >= 20 or Bun (Bun recommended for development; both run the same code).
- A model endpoint: a local [Ollama](https://ollama.com) server, an OpenAI or Anthropic api key, or any OpenAI-compatible API (OpenRouter, vLLM, LM Studio, ...).
- The `lich` CLI, installed from npm. The examples below use the installed binary; from a clone of the repository the same commands run as `bun src/cli.ts ...` (see [Development install (from source)](#development-install-from-source)).

```sh
npm install -g @moikapy/lich
lich --version   # -> 0.3.0
```

## Choose a configuration path

Lich needs exactly one thing before it runs: a model. You can provide it three ways, and they can be mixed (flags override env vars, and both override the config file).

### Path A: environment variables only

```sh
# ollama — no api key needed
LICH_PROVIDER_KIND=ollama LICH_MODEL=llama3.2 lich "Reply with ok"

# openai-compatible (api.openai.com/v1 by default)
LICH_PROVIDER_KIND=openai_compat LICH_MODEL=gpt-4.1-mini lich "Reply with ok"

# anthropic
LICH_PROVIDER_KIND=anthropic LICH_MODEL=claude-sonnet-4 lich "Reply with ok"
```

Defaults per kind when `LICH_BASE_URL`/`LICH_API_KEY_ENV` are unset: `openai_compat` uses `https://api.openai.com/v1` and reads `OPENAI_API_KEY`; `anthropic` uses `https://api.anthropic.com` and reads `ANTHROPIC_API_KEY`; `ollama` uses `http://localhost:11434` and needs no key.

### Path B: the `config` template (recommended)

```sh
mkdir -p .lich
lich config > .lich/config.json
# edit .lich/config.json and replace "<model-name>"
```

`lich config` honors `LICH_PROVIDER_KIND` and `LICH_MODEL` when you have them set, and otherwise prints an ollama-oriented template. The file is picked up automatically from `.lich/config.json` in the working directory (or `~/.config/lich/config.json` as a fallback) — after this, plain `lich "task"` needs no env vars.

`lich init` writes that same starter file for you (it creates `.lich/` and never overwrites an existing `.lich/config.json`). Bare `lich` on a TTY, with no config in that search chain and no `LICH_MODEL`, runs a setup wizard and writes `.lich/config.json` once before opening the TUI. `.lich/` is gitignored.

### Path C: an explicit config file

```sh
lich --config ./lich.json "Reply with ok"
```

The full schema is documented in [the CLI reference](user-guide/cli.md#config-file-reference). Search order: `--config` path first (must exist), then `./.lich/config.json`, then `~/.config/lich/config.json`.

## Your first one-shot

```sh
lich "Use the list_dir tool to list the current directory then reply done"
```

Observed output (stderr progress, then the final answer on stdout):

```
[lich] turn 1
[lich]   list_dir: ok

done
```

Exit code `0` means the model produced a final answer; `1` means the turn budget ran out or the run failed (see [exit codes](user-guide/cli.md#exit-codes)).

## Your first TUI session

```sh
lich        # TUI; first run on a TTY opens the setup wizard
lich tui    # same TUI, no wizard
```

Type a message and press Enter. The transcript shows your line, live tool-call rows while the agent works, and the reply; the status bar at the bottom tracks turns, tokens, and the session file path. Slash commands: `/help`, `/model`, `/usage`, `/clear`, `/sessions`, `/exit`. Details in [the TUI guide](user-guide/tui.md).

## Your first gateway webhook

```sh
lich gateway webhook
```

In another terminal:

```sh
curl -s -X POST http://localhost:8089/message \
  -H "content-type: application/json" -d '{"text": "hello"}'
```

Observed response shape (the `reply` text is the model's answer; `usage` is `null` on this endpoint):

```json
{"reply":"Hello! How can I help you today? I can assist with coding, file management, running commands, web searches, and more — just let me know what you'd like to do.","usage":null}
```

Stop the gateway with Ctrl+C (SIGINT) or `kill` (SIGTERM); both shut down adapters cleanly.

## Where sessions live

Every run appends a JSONL transcript to `.lich/sessions/` (override with `--session-dir` or `session_dir` in config). File names encode time, a counter, and the origin label — `...-tui.jsonl` for TUI runs, `...-gw-webhook-<chat>.jsonl` for gateway conversations.

Each line is a JSON record with a `ts`, a `kind` of `message` or `meta`, and the payload:

```json
{"ts":"2026-09-13T05:21:25.778Z","kind":"message","message":{"role":"user","content":"Use the list_dir tool to list the current directory then reply done"}}
{"ts":"2026-09-13T05:21:25.852Z","kind":"message","message":{"role":"assistant","content":"","tool_calls":[{"id":"ollama_mtzd9c8b_1","name":"list_dir","args":{}}]}}
```

Print just the conversation with `jq`:

```sh
jq -r 'select(.kind=="message") | "\(.message.role): \(.message.content)"' .lich/sessions/<file>.jsonl
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `no model configured: set LICH_MODEL, pass --model, or create .lich/config.json` | No provider was resolvable. Set `LICH_MODEL`, pass `--model`, or save a config file (`lich init` or `lich config`). |
| `lich: config not found: <path>` | `--config` was given a path that does not exist. Check the path or drop the flag to use discovery. |
| Provider error `kind=auth`, http 401/403 | The api key is missing or wrong. Verify the env var named by `LICH_API_KEY_ENV` (default `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`) is exported in the same shell. |
| `fetch failed` / connection refused | The endpoint is unreachable. For ollama, check `ollama serve` is running on `http://localhost:11434`; for remote APIs, check `LICH_BASE_URL`. |
| `[lich] budget exhausted after N turns` | The task did not finish within `max_turns` (default 25). Raise it with `--max-turns 50` or in config. |
| `unknown flag: --foo` | Flag typo, or the flag was placed where a subcommand is expected. Run `lich --help`. |

## Updating

Check the npm registry and install a newer release with:

```sh
lich update
lich --version   # -> the version you just installed
```

`lich update` compares the installed version to `npm view @moikapy/lich version`. When the registry copy is newer, it runs the equivalent command:

```sh
npm install -g @moikapy/lich@latest
```

Exit any running `lich tui` or `lich gateway` first — npm cannot replace the package while those processes are running. A git clone updates with `git pull` instead; `npx` cannot persist an update.

Updates never touch your data: the per-project `.lich/` directory holds your config and session transcripts, installers neither read nor migrate it, and it is gitignored by design so a checkout never collides with it. For what changed between versions, see the [changelog](https://github.com/moikapy/lich/blob/main/CHANGELOG.md).

## Development install (from source)

To hack on Lich itself, run the CLI straight from a clone instead of the npm package:

```sh
git clone https://github.com/Moikapy/lich.git && cd lich
bun install
bun src/cli.ts --version   # -> 0.3.0
```

`bun src/cli.ts` accepts the same arguments as the installed `lich` binary, so every command on this page works unchanged.

## Next steps

- All four CLI modes, flags, and provider resolution: [CLI reference](user-guide/cli.md).
- Slash commands and the status bar: [TUI guide](user-guide/tui.md).
- Telegram, Discord, Twitch, and webhook setup: [Gateway guide](user-guide/gateway.md).
- Embedding the agent in your own TypeScript: [Library guide](user-guide/library.md).
- Session JSONL as a combat log: [Games guide](user-guide/games.md).