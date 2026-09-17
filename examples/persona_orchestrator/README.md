# persona_orchestrator

Pattern only. One lich `Agent` per NPC persona, built with `create_agent_with_plugins`. The multi-NPC service lives in the **game repo**. lich ships this example so that service can copy the helpers. It is not a plugin, and it is not a second agent core. Plugins are called *by* the agent (tools and hooks). This folder is the caller: it constructs agents and routes conversations.

Godot posts the same `POST /message` body it already sends to the gateway. It still drains `.lich/game/`; it does not parse tool calls out of `reply`.

## Boundary

| Lives here | Lives in the game repo |
| --- | --- |
| Persona config table, history cap, promise-chain queue, webhook-shaped HTTP | Process supervision, auth secrets, rate limits, which persona a speaker maps to |
| `round_fate` so budget/abort is visible | What the enemies do when `orders.jsonl` gained no line this round |

There is no basic-attack fallback and no tunable veto table. The meteor gate is the hardcoded check in `examples/game_bridge` (`meteor_gates_closed_until_round_3`, rounds below 3). Combat rules beyond that are the game's.

`MEMORY.md` is never auto-loaded. Dungeon notes are reference data in `.lich/game/memory.jsonl`, written only when the model calls `dungeon_memory_write`.

## Reference design

Copy `personas.ts`, `history_queue.ts`, `reply.ts`, and `orchestrator.ts`. In the game repo, load agents with `create_agent_with_plugins` from `@moikapy/lich` (this checkout's `run.ts` imports `../../src/index.js`).

- **Factory.** `persona_config` merges a shared provider list with one persona's `system_prompt`, `tools_enabled`, `max_turns`, `max_tokens`, `context_budget_tokens`, and `plugins`. It does not copy `mcp_servers`. One `create_agent_with_plugins` call per persona, cached by `persona_id`. `tools_enabled` filters builtins and editor MCP tools. Plugin tools register after the filter, so they are not stripped. An empty `tools_enabled` drops MCP tools even when a server is enabled, and does not throw — the model just replies, plus the gatekeeper's `git_commit` (always registered, fail-closed unless `LICH_ALLOW_SELF_COMMIT=1`). Duplicate tool names warn and skip; first wins.
- **Serialization.** `enqueue` is the GatewayBus promise chain, keyed by `chat_id`. Concurrent posts to one conversation cannot interleave history. Different `chat_id`s run concurrently. The plugin itself still makes no concurrency guarantee; one bridge per `chat_id` is the intended pattern.
- **History cap.** `cap_history` keeps the newest N messages (default 40). Oldest conversations drop at 200. The loop re-seeds `system_prompt` on every run, so losing a stored system line is safe. A cap of N does not keep the whole battle: the oldest overflow is dropped. Restate facts the digest still needs, or write them with `dungeon_memory_write`.
- **Budgets.** Each persona has its own `max_turns`, `max_tokens`, and `context_budget_tokens`. Budget exhaustion returns `stopped_reason: "budget"` and `round_fate` is `game_repo_decides`. The HTTP body is still `{reply, usage}`. This example does not write an order line on that path.
- **Per-run memory.** `chat_id` is `npc:<persona_id>:<run_id>`. History is keyed by the full `chat_id`, so a new run id starts empty. Session labels use `gw:<platform>:<chat_id>`, same as the gateway. Labels are slugified and truncated to 40 characters on disk.
- **Soldier-tier cadence.** Godot calls once per combat round. The commander prompt asks for one `enemy_actions` call covering every living enemy. This process does not schedule rounds.

## Personas

| `persona_id` | `tools_enabled` | Plugins | What the model sees |
| --- | --- | --- | --- |
| `commander` | `[]` | `game_bridge.plugin.mjs` | No builtin file/terminal tools. No `mcp_*` editor tools. Plugin tools `enemy_actions`, `dungeon_memory_read`, `dungeon_memory_write`, plus `git_commit`. |
| `chronicler` | `["read_file"]` | none | Builtin `read_file` only (plus `git_commit`). No game-bridge tools. |

`config.plugins` is loaded only by `create_agent_with_plugins`. `create_agent` does not load plugins. Paths are relative to `work_dir`. If `work_dir` is the game repo, copy `examples/game_bridge/` there and point `plugins` at that copy. Restart to reload; there is no hot reload.

Tool shapes and the meteor gate: [`examples/game_bridge/README.md`](../game_bridge/README.md). Godot drain: [Godot guide](../../docs/user-guide/godot.md). Editor MCP is the opposite direction and is not this persona: [Redot guide](../../docs/user-guide/redot.md). A game master is another persona, not an editor tool. Session replay: [games guide](../../docs/user-guide/games.md).

## HTTP

Loopback only (`127.0.0.1`), default port `8090` so it does not collide with the CLI webhook (`8089` on `0.0.0.0`). Optional `token` checks `x-lich-token`.

```sh
curl -s -X POST http://127.0.0.1:8090/message \
  -H "content-type: application/json" \
  -d '{"text":"round 1: hero1 at full. goblin is the only living enemy.","chat_id":"npc:commander:run-1"}'
```

Success is `{reply, usage}`. `usage` is the run's `usage_total`. The CLI webhook still sends `usage: null`; a Godot client that only reads `reply` needs no change. Missing `text` is `400 {"error":"text is required"}`. A bad token is `401`. Unknown or missing `chat_id` is still `200` with `reply` starting `agent error: unknown persona` and `usage: null` — this example does not default `chat_id` to `"default"`, because a persona cannot be inferred.

From a source checkout, with the working directory at the repo root:

```sh
bun examples/persona_orchestrator/run.ts
```

That entry uses a local Ollama provider. Tests inject `fetch_fn` and never open a network socket to a model.
