# game_bridge

Reference plugin: a lich agent queues Final-Fantasy-style enemy turns for a Godot process. lich and Godot do not share memory. Tools write files under `.lich/game/`; Godot drains them each tick. Godot-side code lives in the game repo.

Node `>=20` loads this entry. Point `config.plugins` at the `.mjs` file (paths are relative to `work_dir`):

```json
{
  "plugins": ["./examples/game_bridge/game_bridge.plugin.mjs"]
}
```

Restart the agent after changing the list. There is no hot reload. Copy this folder into the game repo if `work_dir` is not the lich checkout, and point `plugins` at that copy the same way.

## Round cadence

One `enemy_actions` call per combat round decides every enemy. The gateway serializes runs per conversation, so one bridge per `chat_id` is the intended pattern. The plugin itself makes no concurrency guarantee.

Godot, each tick:

1. Read `.lich/game/orders.jsonl`.
2. Apply the lines.
3. Truncate the file (read + truncate; do not rewrite lines in place).
4. Optionally refresh `.lich/game/state.json` with the current battle snapshot (`round`, hero ids, enemy ids).

Append-only writes keep a drain race from corrupting a line. A line appended during truncate can still be lost; Godot should drain under its own lock if that matters. Duplicate lines for one round are possible if the model calls twice. Dedupe on the Godot side.

`rationale` is the replayable combat-log entry. The agent session JSONL already stores tool-call arguments, so the rationale is in that transcript. This plugin does not write the session store.

## Tools

| Tool | Effect |
| --- | --- |
| `enemy_actions` | Appends one JSONL order line to `.lich/game/orders.jsonl`. Output echoes the appended action count. |
| `dungeon_memory_write` | Appends one note to `.lich/game/memory.jsonl`. |
| `dungeon_memory_read` | Returns the most recent 20 notes, joined by newlines. Empty memory returns `(none)`. |

`action` is an ability id from that enemy's kit, or one of `attack`, `defend`, `flee`. `target_ref` is `hero:<id>` or `enemy:<id>`. `flee` is a valid literal even in a boss fight; Godot decides whether it is allowed.

## File contract

Order line (`orders.jsonl`):

```json
{"ts":"2026-01-01T00:00:00.000Z","round":1,"actions":[{"enemy_id":"goblin","action":"attack","target_ref":"hero:hero1"}],"rationale":"open with a strike"}
```

Memory line (`memory.jsonl`):

```json
{"ts":"2026-01-01T00:00:00.000Z","note":"the player always heals below half"}
```

Snapshot (`state.json`, written by Godot, read by `enemy_actions`):

```json
{"round":1,"heroes":[{"id":"hero1"}],"enemies":[{"id":"goblin"}]}
```

A round that does not match `state.json` is still appended. The tool output then includes `snapshot_round_mismatch: snapshot=<n>`. A missing or unreadable snapshot is ignored.

## Difficulty gate

`before_tool_call` blocks `enemy_actions` when any `action` contains `meteor` and `round` is below 3. The model sees `blocked_by_plugin: meteor_gates_closed_until_round_3` and re-plans in the same run. Round 3 and later pass through. The executor never runs on a blocked call, so no order line is written.

## Failures

Tools return `{ok: false, error}` and do not throw. Reads skip malformed JSONL lines. The first call creates `.lich/game/` if it is missing. `memory.jsonl` grows forever; only the read is capped.
