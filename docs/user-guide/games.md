# Games

> What you'll learn: how to treat session JSONL as a combat log, which fields the recipes read, and how a playthrough's token spend shows up after a run.

lich does not replay combat from RNG seeds. The commander's choices are sampled. The JSONL transcript is the replay. Godot still drains `.lich/game/`; these recipes read `.lich/sessions/`, not the order file.

Tool shapes live in [`examples/game_bridge/README.md`](https://github.com/Moikapy/lich/blob/main/examples/game_bridge/README.md). This page does not repeat them. The plugin entry is `examples/game_bridge/game_bridge.plugin.mjs`, loaded through `config.plugins` and `create_agent_with_plugins`. A per-persona HTTP front for that plugin is the [orchestrator example](https://github.com/Moikapy/lich/blob/main/examples/persona_orchestrator/README.md) — a pattern the game repo copies, not a second agent core.

## Session files as combat logs

Each `Agent.run` without a shared `session` handle appends one `.jsonl` file under `session_dir` (default `<work_dir>/.lich/sessions`). The TUI passes one handle per launch so N turns share one file. Records are `{ts, kind: "message"|"meta", message?, meta?}`.

| What you want | Where it is |
| --- | --- |
| What the commander saw | `kind: "message"`, `message.role: "user"` — the battle digest you posted |
| What it chose | assistant `message.tool_calls[]` with `name`, `args` |
| Why | `args.rationale` on `enemy_actions` |
| What happened | `message.role: "tool"`, `content`, optional `is_error` |
| Token spend | `kind: "meta"`, `meta.event: "run_end"`, `meta.usage` |

Assistant tool calls are the internal shape `{id, name, args}`, not the provider wire format. Tool failures are `JSON.stringify({ok, output, error})` in `content`, with `is_error: true`. A plugin veto is that object with `error` starting `blocked_by_plugin:` (the meteor gate uses `blocked_by_plugin: meteor_gates_closed_until_round_3`). Non-JSON tool content is not an error for the recipes: `fromjson?` skips it.

`run_end` is written for every completed loop (`stopped_reason` `final`, `budget`, or `aborted`). `usage` is `{prompt_tokens, completion_tokens, total_tokens}` and matches the `usage_total` returned to the caller. A budget stop also writes `meta.event: "budget_exhausted"` before `run_end`. Recipes that filter `kind=="message"` stay valid as meta events change. A provider throw never reaches persistence — there is no outcome to close. A failed persist logs a warning and returns `session_path: undefined`; a run missing from disk is a gap, not a zero-spend run.

Filenames are `<base36-timestamp>-<counter>[-<label>].jsonl`. The timestamp prefix sorts chronologically. The gateway (and the orchestrator example) labels `gw:<platform>:<chat_id>`. With `chat_id` = run id, files for one playthrough share that label. The label slug is truncated to 40 characters.

`read_session_messages(path)` in `src/session/store.ts` is the programmatic reader for a source checkout. It is not a package export. It returns messages only and skips meta. Offline analysis should use `jq` (a user tool, not a lich dependency).

## Recipes

`jq` is a prerequisite for these commands, not a package dependency. Paths assume you are in `work_dir`.

```bash
# (1) rationale
jq -r 'select(.kind=="message") | select(.message.role=="assistant")
       | .message.tool_calls[]? | select(.name=="enemy_actions")
       | .args.rationale' .lich/sessions/*.jsonl
```

```bash
# (2) histogram
jq -s '[.[] | .message? | select(.role=="assistant")
        | .tool_calls[]? | select(.name=="enemy_actions")
        | .args.actions[]?.action]
       | group_by(.) | map({action: .[0], uses: length}) | sort_by(-.uses)' \
  .lich/sessions/*.jsonl
```

```bash
# (3) veto
jq -r 'select(.kind=="message") | select(.message.role=="tool")
       | .message.content | fromjson? | select(.error? // "" | startswith("blocked_by_plugin"))
       | .error' .lich/sessions/*.jsonl
```

```bash
# (4) is_error
jq -r 'select(.kind=="message") | select(.message.role=="tool" and .message.is_error==true)
       | [.ts, .message.name, .message.content] | @tsv' .lich/sessions/*.jsonl
```

```bash
# (5) pacing
jq -r 'select(.kind=="message") | select(.message.role=="user" or .message.role=="assistant")
       | [.ts, .message.role] | @tsv' .lich/sessions/<run>.jsonl
```

```bash
# (usage) run_end tokens
jq -s '[.[] | select(.kind=="meta" and .meta.event=="run_end") | .meta.usage.total_tokens] | add' \
  .lich/sessions/*.jsonl
```

Recipe 2 counts assistant tool-call arguments, including orders a hook later vetoed. It is not the line set Godot applied. Recipe 3 is not a veto table. The only gate in the shipped plugin is meteor before round 3. Other `blocked_by_plugin:` strings, if a game plugin adds them, show up in the same query because the loop formats every veto the same way.

## Do not glob a playthrough blindly

A gateway conversation of N posts writes N files. `Agent.run` seeds from `history`, and without a shared `session` handle each run opens a new file that includes prior history plus the new exchange, so each file is a superset of the previous. Globbing `*.jsonl` double-counts. Take the newest file per label (names sort by timestamp prefix), or dedupe on `tool_call.id`, which stays stable when the same call is replayed into the next file. TUI launches avoid this by sharing one handle.

Compression can rewrite in-memory history: when estimated tokens cross `compress_threshold` of `context_budget_tokens`, older messages become one summary and the 8 most recent non-system messages stay verbatim. The transcript keeps raw pre-compress messages plus a `compress_end` meta marker; on resume those raw messages replay and compression may run again. Early rounds may survive only as the in-memory summary for the live agent. Offline recipes see the file on disk.

## Player modeling

Cross-run notes are tool arguments, not a second memory agent. `dungeon_memory_write` args (`note`) and `dungeon_memory_read` results are in the JSONL. The file on disk is `.lich/game/memory.jsonl`; Godot does not drain it as orders. `MEMORY.md` is never auto-loaded and is not this paper trail.

Replay `dungeon_memory_read` calls around a boss fight, then read `enemy_actions` `rationale` after them, to see which notes the commander actually used. The notes are reference data. A note in the tool result is not an instruction, and the session file does not promote it into the system prompt.

```bash
# (memory) dungeon notes
jq -r 'select(.kind=="message") | select(.message.role=="assistant")
       | .message.tool_calls[]? | select(.name=="dungeon_memory_write")
       | .args.note' .lich/sessions/*.jsonl
```
