---
title: Client-executed tools (tool.invoke / tool.result)
created: 2026-09-23
updated: 2026-09-23
type: concept
tags: [serve, games, npc, tools]
sources: [raw/audits/2026-09-23-game-surface-audit.md, "#113"]
confidence: medium
---

# Client-executed tools

**Idea:** the game, not Lich, owns its tools.
1. The client declares tool schemas when it creates a session.
2. When the model calls one, the server sends a JSON-RPC **request** to the client: `tool.invoke {call_id, name, args, deadline_ms}`.
3. The client executes it in the engine and replies with `tool.result {ok, output}`.

**Why:**
- **It replaces the racy file bus.** The `orders.jsonl` polling in [[game-bridge-example]] can lose or duplicate lines.
- **Actions become typed and synchronous.** The game validates and applies them at once.
- **World-state queries become possible.** Tools like `get_nearby_entities` or `line_of_sight` run against the live game state.
- **Safety by construction.** Lich never needs file or terminal access inside a game; see [[embedded-safety-profile]].

**Design notes:**
- It needs a transport that can push, so it only works on the **interactive** adapter ([[0001-gateway-as-hub]]). A profile that needs client tools must be refused on text-only adapters.
- **Deadlines:** if the client doesn't answer in time, the call becomes a tool error, and the loop decides what happens next ([[action-terminal-mode]] fallback).
- **Pairs with `ToolContext` identity:** the server tells the client which session or NPC the call belongs to ([[npc-memory-namespaces]]).
- Hermes has a similar round trip for approvals (`approval_gateway_wait.py`), but not for general tools.

Related: [[lich-serve]], [[game-transports]].
