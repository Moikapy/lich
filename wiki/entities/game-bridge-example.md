---
title: game_bridge example (file-bus combat commander)
created: 2026-09-23
updated: 2026-09-23
type: entity
tags: [games, npc, plugins]
sources: [raw/audits/2026-09-23-game-surface-audit.md]
confidence: high
---

# game_bridge example

`examples/game_bridge/*` is shipped in the npm package. It is a plugin that turns Lich into an enemy commander for a turn-based Godot game.

- **`enemy_actions` tool:** appends JSONL orders to `.lich/game/orders.jsonl`, which the game drains. It compares `state.json` on `round` only.
- **`dungeon_memory` tool:** an append-only `memory.jsonl`, of which reads return at most 20 notes.
- **`meteor_veto` hook:** a `before_tool_call` hook that blocks meteor before round 3.

## Weaknesses

- **The file bus is racy by design.** A line can be lost mid-truncate, and a line can be duplicated.
- **Small models may skip the tool, or call it twice.** The docs tell developers to always drain the file.
- **Every decision costs at least 2 LLM calls,** because the model always gets a turn after the tool runs.
- **Every NPC shares one orders file and one memory file.**

## Future

Deferred in #114, item 4: retire the file bus once [[client-executed-tools]] and the GDScript SDK exist. The proposed replacement for the double LLM call is [[action-terminal-mode]]. Until then, keep the docs, because this is the only working Godot path.

Related: [[godot-and-redot]], [[persona-orchestrator-example]], [[lich-sessions]].
