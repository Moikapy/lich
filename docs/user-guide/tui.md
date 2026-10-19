# TUI guide

> What you'll learn: how to launch the terminal UI, read its layout and status bar, use slash commands and input history, and how memory and session persistence work across turns.

## Launching

```sh
lich         # front door: TUI, plus a first-run setup wizard when no config exists
lich tui     # same TUI, no wizard. From a clone: bun src/cli.ts tui
```

The TUI needs a TTY and a resolvable provider (same resolution as every mode). On startup it prints a dim header from the active theme welcome string, e.g. `⚱ lich v0.8.0 — the agent that will not stay dead · qwen3:8b (ollama)`. `{version}` is `LICH_VERSION` from `package.json`. That banner is the only tagline placement. Quit with `/exit`, `/quit`, `/q`, or Ctrl+C. Esc cancels a running turn.

## Anatomy

```
⚱ lich v0.8.0 — the agent that will not stay dead · qwen3:8b (ollama)

──────────────────────────────────────────────────
● mortal  list the files here                   <- your input, under a rule
┊ ✓ list_dir  0.0s · d src/                     <- one row per tool call
┊ ✗ read_file  missing.txt  0.0s · not found    <- failed calls are red

⚱ lich                                          <- the agent's reply (`response_label`)
  Here is what I found ...
──────────────────────────────────────────────────
› ▌                                             <- input row (cursor block)
dormant · qwen3:8b · turn 2 · 1,204 tokens · m1x9k-2-tui
```

- **Header** — theme welcome string (version, model, provider kind). The tagline appears only here.
- **Transcript** — your turns (`● ` plus the theme `user_label`, `mortal` by default) under a dim rule; replies under a `glyph response_label` header (`⚱ lich`), indented; and meta notices (`· context compressed — memories distilled ...`, `· error: ...`). Each tool call is one `┊`-guided row: `✓`/`✗`, the tool name, its main argument (path, command, url, ...; compact JSON otherwise), its run time, and the first line of its output, cut to the terminal width. A running call shows a spinner on the same row. Resumed transcripts show tool rows without run times. The view keeps the newest 50 blocks; older lines scroll out of the transcript (session JSONLs still hold everything — see [limitations](#known-limitations)).
- **Input row** — `› ` when idle, `· ` with an `esc to cancel` hint while the agent works; Enter submits, Backspace edits, pasted newlines collapse to spaces, and Esc cancels a running turn (a `· run cancelled` notice follows).
- **Status bar** — the line under the input; see below.

## Slash commands

| Command | Effect |
| --- | --- |
| `/help` | Print the command list and key hints. |
| `/model` | Show the active model and provider kind (from `providers[0]`). |
| `/usage` | Show tokens used this session (cumulative across turns). |
| `/clear` | Wipe the on-screen transcript. Does **not** reset agent memory — the next message still sees prior turns. |
| `/sessions` | List the 10 newest `.jsonl` files in `session_dir` with sizes. The heading uses the theme sessions label (`phylacteries (n):` by default). |
| `/resume <id\|latest>` | Load a stored transcript into agent history (exact id, unique prefix, or `latest` by mtime — same resolver as `--resume`). Resets the on-screen transcript with a `· resumed <id> (n messages)` notice and updates the header banner. Missing/ambiguous ids print an error notice. |
| `/exit`, `/quit`, `/q` | Exit the TUI. |

Unknown commands print `· unknown command: /x (try /help)`. Slash commands are handled client-side and never invoke the model.

## Input history

Up/Down arrow keys walk a 20-entry recall ring of previously submitted lines (newest first); submitted duplicates move to the top instead of repeating. Recall position resets when you submit.

## Status bar

The bottom line shows, left to right:

| Segment | Meaning |
| --- | --- |
| `dormant` / `deliberating` / `casting` | Current phase (colored): waiting for input, calling the model, or executing a tool. Labels come from the theme. |
| `<model>` | First provider's model from config. |
| `turn N` | Turns used by the most recent run (resets each message). |
| `N tokens` | Cumulative session token usage (prompt + completion, across all turns). |
| `compressed N` | How many times context compression fired this session (hidden when 0). |
| `<session id>` | Id (file name without `.jsonl`) of the newest persisted transcript (appears after the first run); use it with `/resume`. |
| `· budget exhausted — the ritual is spent (turn cap reached)` | Red notice when a run hit the turn cap. The keyword stays; the flavor comes from the theme. |

## Multi-turn memory

The TUI keeps one conversation: every submitted message is sent together with the full prior message history, so the agent remembers earlier turns for as long as the session stays open. When estimated tokens cross `compress_threshold` of `context_budget_tokens`, older turns are replaced by an LLM-generated summary (the 8 most recent messages always stay verbatim) and a `· context compressed — memories distilled` notice appears. There is deliberately no per-conversation reset command — `/clear` only clears the display; start a fresh `lich tui` process for an empty context.

## Known limitations

- The transcript keeps only the newest 50 blocks; older context scrolls away (it remains in the session file).
- No token streaming: replies appear once the model finishes the turn.
- No per-conversation reset — `/clear` is cosmetic; restart the TUI to reset memory.
- Tool output previews are truncated to 120 chars per row; read the session JSONL for full output.

## Tips

- Use `/clear` when the transcript is visually noisy and you want to keep reading from the top — memory is unaffected.
- After a long session, inspect what actually happened: `jq -r 'select(.kind=="message") | "\(.message.role): \(.message.content // "(tool call)")"' .lich/sessions/<newest>-tui.jsonl`.
- Watch `compressed N` in the status bar: if it climbs steadily in short sessions, lower `context_budget_tokens` or expect summarization of older details (file paths survive compression; long verbatim outputs do not).