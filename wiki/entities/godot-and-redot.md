---
title: Godot and Redot integration
created: 2026-09-23
updated: 2026-09-23
type: entity
tags: [engines, games, editor, npc]
sources: [raw/audits/2026-09-23-game-surface-audit.md]
confidence: high
---

# Godot and Redot

There are two opposite integration directions (`docs/user-guide/godot.md`, `redot.md`):

- **The game connects to Lich** (Godot, runtime). The game posts a battle digest to the webhook ([[lich-gateway]]). The model calls a `game_bridge` tool that writes `.lich/game/orders.jsonl`, and Godot polls, applies and truncates that file. See [[game-bridge-example]]. The documented latency is "seconds, not frames… once per combat round".
- **Lich connects to the editor** (Redot, editor time). Lich runs `redot --headless --mcp-server` as an MCP catalog entry ([[lich-mcp]]). Godot has no official MCP, so its catalog entry is `transport: "none"`.

## Engine facts relevant to the roadmap

- **Godot `WebSocketPeer`** can speak to [[lich-serve]] directly. A GDScript addon (an autoload that emits signals) is the first SDK planned, and it would cover both Godot and Redot (#113 §4(C)).
- **Headless runs** (`godot --headless --script …`) and the GUT and GdUnit test runners are the natural targets for engine-aware `run_tests` recipes (#113 §4(A)).

## Doc bug (open)

`godot.md:33,151` claims the webhook binds `0.0.0.0`. The code binds `127.0.0.1`.

Related: [[game-transports]], [[client-executed-tools]].
