---
title: persona_orchestrator example
created: 2026-09-23
updated: 2026-09-23
type: entity
tags: [npc, games, gateway]
sources: [raw/audits/2026-09-23-game-surface-audit.md]
confidence: high
---

# persona_orchestrator example

`examples/persona_orchestrator/*` builds **one Agent per persona**. Each conversation is keyed by `chat_id = npc:<persona>:<run>`, and requests arrive over a loopback HTTP server on port 8090 that returns `{reply, usage}`.
- Runs for one key are serialized, and each persona has a budget.
- The game repository is meant to copy this code; it is "not a second core".

## Why it exists, and why it should shrink

Today's `Agent` is heavy: every instance builds its own router, tools, plugins and MCP connections, and a single run can't override the prompt, tools or model. Per-NPC personas therefore need a separate Agent each, plus orchestration code around them.

With [[runtime-profile-session]] in place, this example collapses to about 20 lines: one Runtime, one Profile per persona, and one Session per NPC instance. That work is deferred in #114, item 4.

## Doc bug

`README.md:42` says the webhook binds `0.0.0.0`. The code binds `127.0.0.1` (see [[lich-gateway]]).

Related: [[npc-memory-namespaces]], [[game-bridge-example]].
