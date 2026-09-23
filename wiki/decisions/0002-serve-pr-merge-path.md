---
title: "0002: Merge path for the open serve PRs"
created: 2026-09-23
updated: 2026-09-23
type: decision
tags: [decision, serve, ossuary, events, roadmap]
sources: [raw/issues/issue-113.md, raw/audits/2026-09-23-game-surface-audit.md, raw/audits/2026-09-23-core-engine-audit.md]
status: proposed
issue: "#113"
revisit_when: "#101/#102 merge, or Ossuary panes start consuming event payload fields"
---

# 0002: Serve PR merge path

## Context

None of the serve PRs had merged when this was written (2026-09-23):
- #99: transport and health (#81)
- #101: sessions (#82)
- #102: prompt and events (#83)
- #103: CLI (#84)

The Ossuary panes (#86–#94) render from serve `event` notifications, which carry raw `AgentEvent` values with no run or session id. #102 also adds a single global queue (`run_tail`), because `agent.events` is process-wide. ^[raw/audits/2026-09-23-game-surface-audit.md] Changing direction is cheap now, and gets more expensive with every pane built on top.

## Decision

A middle path (#113 Addendum 2 §A):

1. **Merge #99 and #103 as they are.** Loopback binding, the token, health and the CLI are needed under either design.
2. **Before #101 and #102 merge,** move serve's `sessions.ts` bag and the `run_tail` queue into one shared **SessionManager** that `gateway/bus.ts` will also use. It keeps a queue per session and runs different sessions concurrently.
3. **Before #102 merges,** add the [[event-envelope]]: `run_id`, `session_id`, `seq` and `ts` on every event, plus a JSON-safe `error`. This is the most time-sensitive step.
4. **Defer** moving the messaging adapters onto the SessionManager (#114 item 2).

## Consequences

- Ossuary is not blocked. Its client depends only on #80's method names, which are already merged and stable.
- The event shape settles before any pane reads it, so no pane-by-pane rewrite later.
- 10 NPCs no longer wait behind one global queue.
- #82 and #83 may move back to In Progress on the kanban until steps 2 and 3 land.

## Alternatives considered

- **Retarget #81–#84 as gateway-adapter work now.** Rejected: the whole Ossuary track would wait on a gateway refactor.
- **Land everything as it is.** Rejected: it bakes in the global queue, serve-only sessions, and an event shape that can't tell sessions apart.

## Revisit when

#101 and #102 merge (verify that steps 2 and 3 were done), or any pane starts reading event fields beyond `type`.

Related: [[0001-gateway-as-hub]], [[lich-serve]], [[ossuary]].
