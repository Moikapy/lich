---
outline: [2, 3]
---

# Lich documentation

> What you'll learn: what Lich is, what it ships, and which page to read next — plus a 60-second quickstart.

Lich is a TypeScript AI agent harness: a library and a CLI that run a chat model inside a Think-Act-Observe loop. A chat wrapper forwards one prompt and prints one completion. A harness keeps going: the model plans (think), calls tools such as `read_file` or `terminal` (act), reads the tool results (observe), and repeats until it can produce a final answer. Lich wraps that loop with the machinery real deployments need: provider failover with bounded retries, path confinement and output clamps on every tool, context compression when the transcript grows past a token budget, and append-only JSONL session transcripts.

One package, four ways to drive the same agent: a one-shot CLI, an interactive chat REPL, an ink-based terminal UI, and a long-running messaging gateway that bridges Telegram, Discord, Twitch, and a zero-config HTTP webhook. All four share the same builtin tools, the same provider configuration, and the same session store.

## Feature overview

| Capability | What it gives you |
| --- | --- |
| Providers | `openai_compat`, `anthropic`, and `ollama` with automatic failover between configured providers; 429/5xx and network errors retry with backoff before failing over. |
| Tools | Builtins (file read/write/edit, directory listing, shell, grep, HTTP fetch/request, web search, process list, disk usage, env inspection, `run_tests`), all confined to the working directory. `git_commit` is the gatekeeper's tool, not a config plugin. |
| Context compression | Transcript summarized in place when estimated tokens cross `compress_threshold` of `context_budget_tokens`; the 8 most recent turns always stay verbatim. |
| Sessions | Every run persists a `.jsonl` transcript under `.lich/sessions/`, labeled by origin (`tui`, `gw:<platform>:<chat>`). |
| CLI | One-shot tasks, chat REPL, TUI, gateway, and a `config` template command, all with flag/env/config-file configuration. |
| TUI | Live ink transcript with tool-call rows, status bar (model, turns, tokens, session path), and slash commands. |
| Gateway | One shared agent behind webhook/Telegram/Discord/Twitch with per-conversation memory (40-message history cap) and per-platform message splitting. |
| Library | `create_agent` / `run_agent` with typed events (`AgentEmitter`), multi-turn history, and `ProviderError` kinds for error handling. |
| Plugins | User-supplied tools and lifecycle hooks (`before_tool_call` veto, run lifecycle) loaded at startup from explicit module paths. |

## Page map

| Page | Read it to |
| --- | --- |
| [Getting started](getting-started.md) | Install, configure a provider, and get your first reply in any mode. |
| [CLI reference](user-guide/cli.md) | Master all four modes, flags, provider resolution, and config files. |
| [TUI guide](user-guide/tui.md) | Run the terminal UI and use slash commands and the status bar. |
| [Gateway guide](user-guide/gateway.md) | Wire Telegram, Discord, Twitch, and the HTTP webhook to one agent. |
| [Library guide](user-guide/library.md) | Embed the agent in TypeScript with events and multi-turn history. |
| [Plugins guide](user-guide/plugins.md) | Add your own tools and lifecycle hooks, and run the self-improvement loop. |
| [Godot guide](user-guide/godot.md) | Run lich beside a Godot game and drain `.lich/game/` orders each tick. |
| [Redot guide](user-guide/redot.md) | Add editor MCP servers (Redot catalog entry). Play still uses the game bridge, the opposite direction. |
| [Games guide](user-guide/games.md) | Replay session JSONL as a combat log, including token totals. |
| [Architecture overview](architecture/overview.md) | Understand how the harness works inside. |

## How it works

For the internals — the agent loop, provider failover, tool guardrails, and how to extend each layer — read the architecture track: [overview](architecture/overview.md), [agent loop](architecture/agent-loop.md), [providers](architecture/providers.md), [tools](architecture/tools.md), [plugins](architecture/plugins.md), and [extending](architecture/extending.md).

## 60-second quickstart

Requires Node >= 20 (or Bun) and access to one model endpoint (local Ollama, OpenAI, Anthropic, or any OpenAI-compatible API such as OpenRouter).

```sh
# install the CLI globally
npm install -g @moikapy/lich

# generate a starter config, then edit the model name
mkdir -p .lich && lich config > .lich/config.json

# chat TUI (exit with /exit or Ctrl+C)
lich tui

# or a one-shot task
lich "list the files in this repo and summarize it"

# or a messaging gateway on http://localhost:8089
lich gateway webhook
```

Working from a clone of the repository? `bun install`, then run the same commands as `bun src/cli.ts ...` — see [getting started](getting-started.md#development-install-from-source).

## Version compatibility

Documented for **v0.3.0**. The npm package requires Node >= 20 (`engines` in `package.json`); Bun is the recommended runtime for development from a clone (`bun src/cli.ts ...`). The TUI needs a TTY; the gateway and library run headless on both runtimes.