---
title: Game transports (library vs webhook vs file bus vs serve vs stdio)
created: 2026-09-23
updated: 2026-09-23
type: comparison
tags: [games, serve, gateway, engines, npc, play]
sources: [raw/audits/2026-09-23-game-surface-audit.md, raw/issues/issue-113.md]
confidence: medium
---

# Game transports

This page compares how a game, engine or harness can talk to Lich. The findings come from the game-surface audit. ^[raw/audits/2026-09-23-game-surface-audit.md]

| Transport | Push to the game | Cancel | Latency overhead | Engine support | Safety posture | Status |
|---|---|---|---|---|---|---|
| **In-process library** (`create_agent`) | yes (callbacks/events) | yes (`AbortSignal`) | none | JS/TS hosts only: web games, Node sim servers, Electron | whatever the host configures; no network surface | available |
| **Webhook HTTP** (`POST /message`) | no; one reply per request | no | one HTTP round trip | anything with HTTP; GDScript sketch in `godot.md` | loopback by default, token required off-loopback, read-only tools by default | available ([[lich-gateway]]) |
| **File bus** (`orders.jsonl`, `state.json`) | no; the game polls | no | polling interval | anything with file I/O | racy: lines lost mid-truncate, duplicates | example only ([[game-bridge-example]]) |
| **serve** (WebSocket JSON-RPC) | yes (notifications, and later server→client requests) | yes (`prompt.abort`) | one WebSocket frame | Godot `WebSocketPeer`, Unity and Unreal WebSocket modules | loopback + stdout token; inherits the CLI's `tools_enabled: "all"` today | PRs open ([[lich-serve]]) |
| **stdio** JSON-RPC | yes | yes | lowest out-of-process cost | Python/Gym harnesses, editor plugins; awkward on consoles and mobile | no network surface | not built |

## Verdict by use case

- **A. Coding games:** the CLI/TUI plus editor MCP (see [[lich-mcp]]). Transport barely matters here; what matters is engine-aware tools and skills.
- **B. Playing games:** **stdio** to a Python environment bridge (Gymnasium, retro emulators), or the library for browser games. Needs `lich env` and image observations (#113 §4(B)).
- **C. Embedded NPCs and game masters:** **serve over WebSocket**, once it has:
  - per-session concurrency
  - profiles
  - [[client-executed-tools]]
  - [[streaming-deltas]]
  - deadlines

  It is the only option that pushes, cancels and works with every major engine. JS/TS games should use the library directly.

## Why not keep the webhook for games

The webhook has three problems for games:
- It is text in, text out, so it can't push, stream or ask the game to run a tool.
- It returns `usage: null`, and a failed run still returns HTTP 200.
- It pushes the action channel onto the racy file bus.

It stays as a *text adapter* under the gateway hub ([[0001-gateway-as-hub]]), and it remains fine for turn-based "once per round" prototypes.

## Latency rule of thumb

Whatever the transport, **model calls dominate**. Every tool round costs a full extra LLM call, so [[action-terminal-mode]] saves more time than any transport choice. The latency table in the #113 §7 doc draft is an estimate and has not been benchmarked.

Related: [[godot-and-redot]], [[build-everything-around-the-gateway]].
