# Profiles

A profile is a named config, such as `coder` or `bard`, that you can switch between without editing project files. Profiles live under `~/.lich/profiles/`, next to the global config.

```
~/.lich/
├── config.json        # global defaults (see the CLI reference: Global config)
└── profiles/
    ├── coder.json     # any config keys: model, agent_name, max_turns, plugins, ...
    └── coder.md       # optional "soul": becomes the system prompt
```

## Layers

A run merges up to three files, each overriding the one before it key by key:

1. `~/.lich/config.json` (global)
2. `~/.lich/profiles/<name>.json` (the selected profile)
3. `<work_dir>/.lich/config.json` (project)

The merge rules are the same as for the global config. It is a shallow merge. A later `providers` array replaces the earlier one and drops the earlier `models` unless the later layer sets its own. `work_dir` and `session_dir` in a profile are ignored. Relative `plugins` paths in a profile resolve against `~/.lich/profiles/`.

A profile only needs the keys that differ from your global config. For example, a profile that just changes the model:

```json
{ "agent_name": "coder", "providers": [{ "kind": "ollama", "name": "main", "model": "qwen3:8b" }] }
```

`--config <path>` still replaces every layer and cannot be combined with `--profile`.

## The soul file

When `<name>.md` exists and is not blank, its contents become the profile's `system_prompt`, replacing any `system_prompt` in `<name>.json`. A project `system_prompt` still wins over it. A profile can be only a soul file, with no JSON.

## Choosing a profile

The first of these that is set wins:

1. `--profile <name>` on the command line
2. the `LICH_PROFILE` environment variable
3. a `profile` key in the project `.lich/config.json`
4. the default profile: a `profile` key in `~/.lich/config.json`, set by `lich profile use`

A named profile that does not exist is an error (`profile not found: <name>`). Profile names use lowercase letters, digits, `-` and `_`. When `--profile` or `LICH_PROFILE` is set, bare `lich` skips the setup wizard.

## Commands

| Command | Effect |
| --- | --- |
| `lich profile list` | List profiles. `*` marks the default; `(soul)` marks a profile with a `.md` file. |
| `lich profile show <name>` | Print the profile's JSON and its soul file's path and length. |
| `lich profile create <name>` | Run the setup wizard and write `~/.lich/profiles/<name>.json`. Needs a TTY; never overwrites. |
| `lich profile use <name>` | Make `<name>` the default by setting `profile` in `~/.lich/config.json` (other keys are kept). |

To clear the default, remove the `profile` key from `~/.lich/config.json`.

## Safety

File tools cannot read or write `.lich/profiles/` under the working directory, just as they cannot touch `.lich/config.json`. When the working directory is your home directory, these are your global identity files. Profiles hold env var *names* for keys (`api_key_env`, `token_envs`), never the secrets themselves.
