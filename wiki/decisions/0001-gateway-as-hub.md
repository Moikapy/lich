---
title: "0001: Build everything around the gateway (gateway as hub)"
created: 2026-09-23
updated: 2026-09-23
type: decision
tags: [decision, gateway, serve, surface, npc]
sources: [raw/issues/issue-113.md, raw/audits/2026-09-23-game-surface-audit.md, raw/audits/2026-09-23-hermes-vs-lich.md]
status: proposed
issue: "#113"
revisit_when: "A surface needs something the gateway core can't serve in-process or over loopback (e.g. a hard real-time frame budget)"
---

# 0001: Gateway as hub

## Context

- Lich has two out-of-process front doors, [[lich-gateway]] (text in, text out) and [[lich-serve]] (JSON-RPC over WebSocket). They were heading toward two separate implementations of sessions, queues, eviction and access control.
- Serve uses one global run queue across all sessions. The gateway's `bus.ts` already runs each conversation in order while running different conversations concurrently, which is the scheduling many NPCs need. The gateway's `access.ts` also defaults to read-only tools. ^[raw/audits/2026-09-23-game-surface-audit.md]
- Hermes is built this way: its gateway owns sessions, keeps one agent per session, and runs the cron ticks. ^[raw/audits/2026-09-23-hermes-vs-lich.md]

## Decision

Make the gateway the hub, with serve as its most capable adapter (#113 Addendum 1).

The gateway core:
- **SessionManager:** evolves from `bus.ts`.
- **Runtime:** shared, one per process.
- **Profiles and Policy:** evolve from `access.ts`.
- **Scheduler:** world ticks.

Adapters are grouped by what they can do:
- **text:** telegram, discord, twitch, webhook
- **streaming:** SSE or WebSocket
- **interactive:** WebSocket JSON-RPC, i.e. today's serve, with [[client-executed-tools]], abort, approvals and observations

Engine SDKs, [[ossuary]] and eventually the TUI all connect to the interactive adapter. The core is the [[runtime-profile-session]] split.

## Consequences

- Concurrency, eviction, access control and usage accounting are built once.
- The `orders.jsonl` file bus and the copy-paste persona orchestrator can be retired (#114 items 2–4).
- `AgentConfig` stops embedding the gateway's config schema.
- One long-lived process holds every session. That makes ownership of each session, per-profile tool limits and fail-closed hooks mandatory ([[embedded-safety-profile]]).
- Adapters must declare their capabilities. A profile that needs client-executed tools or streaming fails loudly on a text-only adapter.

## Alternatives considered

- **Keep serve as a separate server beside the gateway.** Rejected: sessions, queues and policy would be duplicated, and the two would drift.
- **Put every surface on the library directly.** Rejected as the only path. Engines can't embed Node. The library stays underneath the gateway for JS/TS hosts and tests.

## Revisit when

A surface needs something that neither the in-process gateway nor loopback can deliver. Also check whether local TUI use suffers measurably from the loopback hop; if so, add an in-process gateway mode.

Related: [[0002-serve-pr-merge-path]], [[game-transports]], [[build-everything-around-the-gateway]].
