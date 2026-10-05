---
title: Lich config layers (global, profile, project)
created: 2026-10-05
updated: 2026-10-05
type: entity
tags: [config, cli, security]
sources: ["#117", "#170", "#171", "#172"]
confidence: high
---

# Lich config layers

How the CLI turns files into one config before `parse_agent_config`. The user docs are `docs/user-guide/cli.md` (Global config) and `docs/user-guide/profiles.md`. This page records the design and the reasons for it.

## Layers

Without `--config`, `load_layered_config` (`src/cli_config.ts:127@ab0f508`) merges, base first:

1. **Global:** `~/.lich/config.json` (`src/cli_config.ts:44@ab0f508`). The legacy `~/.config/lich/config.json` is read only when the global file is absent, with a one-line note; nothing writes it.
2. **Profile:** `~/.lich/profiles/<name>.json` (`src/cli_config.ts:89@ab0f508`), plus `<name>.md` as `system_prompt` when it is not blank (`src/cli_config.ts:105@ab0f508`).
3. **Project:** `<work_dir>/.lich/config.json`.

`--config <path>` replaces every layer, and combining it with `--profile` is an error.

**Merge** (`merge_config_layers`, `src/cli_config.ts:175@ab0f508`): shallow, later layer wins per key. A later `providers` array replaces the earlier one and drops the earlier `models` unless the later layer sets its own, because role chains name providers.

**Global and profile layers** (`global_layer`, `src/cli_config.ts:190@ab0f508`): `work_dir` and `session_dir` are ignored. Relative `plugins` paths resolve against the file's own directory (`~/.lich` or `~/.lich/profiles`), not the project.

**Profile selection:** `--profile`, then `LICH_PROFILE`, then a `profile` key in the project file, then one in the global file (set by `lich profile use`, `src/cli_profile.ts:107@ab0f508`). The `profile` key is removed from the merged config. `LICH_PROFILE` is ignored when `--config` is given.

**Work_dir = home:** the project file *is* `~/.lich/config.json`. It is not merged over itself, and a selected profile goes over it rather than under it.

## Writers

- `write_lich_config` (`src/cli_config.ts:277@ab0f508`) is the only writer of `.lich/config.json` files (project and global); profile JSON is written by `lich profile create` (`src/cli_profile.ts:101@ab0f508`). Create mode uses an exclusive open; update mode writes a temp file and renames it into place, keeping the file mode (`src/cli_config.ts:307@ab0f508`, #166).
- `lich init` writes the project file; `lich init --global` writes the global one, without `work_dir`/`session_dir` (`src/cli.ts:694@ab0f508`).
- The setup wizard runs only when no file exists anywhere in the chain. Its last question can save the answers globally; discovered project plugins then stay in the project file, or are stored absolute when the project file is the global file (`src/cli.ts:615@ab0f508`).
- `lich profile create` writes a profile through the wizard and never overwrites. `lich mcp` edits only the project file.

## Guard

File tools refuse `.lich/config.json` and `.lich/profiles/` for reads and writes (`src/tools/guard.ts:83@ab0f508`). `list_dir` and `disk_usage` check their root and skip denied entries (`file_tool_denied`, `src/tools/guard.ts:100@ab0f508`). With `work_dir` = home these paths are the global identity files.

## Two kinds of "profile"

- **Config profile (#117, shipped):** a named file layer chosen per CLI run. It holds any config keys, including identity and model.
- **Runtime Profile (#113 §2b, not built):** cheap, data-only, chosen per session inside one Runtime ([[runtime-profile-session]]).

A config profile could later seed a runtime Profile, but today they are separate things. Name new code accordingly.

## Errors

`tui`, `chat`, `serve` and `gateway` give the "no model configured" hint only for that error. Others pass through as `lich <mode>: <message>` (`src/cli.ts:150@ab0f508`). The profile errors (`profile not found`, `profile <name> already exists`) carry no absolute paths (`.cursor/review-rules.md`). `config not found` and `invalid config json` still name the file.

Related: [[lich-tools-and-guardrails]], [[hermes-agent]] (its profiles are separate home directories; Lich layers files instead).
