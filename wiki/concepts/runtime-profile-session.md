---
title: Runtime / Profile / Session split
created: 2026-09-23
updated: 2026-09-23
type: concept
tags: [core, runtime, npc, gateway]
sources: [raw/audits/2026-09-23-core-engine-audit.md, raw/audits/2026-09-23-game-surface-audit.md, "#113"]
confidence: medium
---

# Runtime / Profile / Session

**Problem:** each `Agent` constructs its own router, 13–15 builtins, plugins and MCP child processes, and a single run can't override the prompt, tools or model. As a result, 100 NPCs means 100 heavy agents. The gateway works around this by sharing one Agent for everyone, and [[persona-orchestrator-example]] by creating one Agent per persona.

**Proposal** (#113 §2b):

| Piece | Cardinality | Holds |
|---|---|---|
| **Runtime** | 1 per process | providers and router, tool registry, MCP connections, plugin host, session store |
| **Profile** | cheap, data-only | `system_prompt`, toolsets, model route, budgets, temperature, `memory_namespace`, `safety: dev \| embedded` |
| **Session** | 1 per conversation or NPC instance | history, memory handle, run queue, event stream scoped by `session_id` + `run_id` |

**Examples of Profiles:** `goblin_shaman`, `game_master`, `godot_coder`.

**Where it goes:** under [[0001-gateway-as-hub]], this split becomes the gateway core:
- `bus.ts` grows into the SessionManager.
- `access.ts` grows into Profiles and Policy.

`session.create({profile})` in [[lich-serve]] then fixes the "one Agent for every session" problem.

**Prerequisites:** remove process-global state (docs root, log level, Ollama id counter), and add the [[event-envelope]].

Related: [[npc-memory-namespaces]], [[embedded-safety-profile]].
