---
title: "0002: Merge path for the serve PRs"
created: 2026-09-23
updated: 2026-09-24
type: decision
tags: [decision, serve, ossuary, events, roadmap]
sources: [raw/issues/issue-113.md, raw/audits/2026-09-23-game-surface-audit.md, raw/audits/2026-09-23-core-engine-audit.md]
status: superseded
issue: "#113"
revisit_when: "SessionManager and the event envelope land from #114 item 2"
---

# 0002: Merge path for the serve PRs

## Context

None of the serve PRs had merged when this was written (2026-09-23):
- #99: transport and health (#81)
- #101: sessions (#82)
- #102: prompt and events (#83)
- #103: CLI (#84)

The Ossuary panes (#86–#94) render from serve `event` notifications, which carry raw `AgentEvent` values with no run or session id. #102 also adds a single global queue (`run_tail`), because `agent.events` is process-wide. ^[raw/audits/2026-09-23-game-surface-audit.md] Changing direction was cheap then, and gets more expensive with every pane built on top.

## Decision

A middle path (#113 Addendum 2 §A):

1. **Merge #99 and #103 as they are.** Loopback binding, the token, health and the CLI are needed under either design.
2. **Before #101 and #102 merge,** move serve's `sessions.ts` bag and the `run_tail` queue into one shared **SessionManager** that `gateway/bus.ts` will also use. It keeps a queue per session and runs different sessions concurrently.
3. **Before #102 merges,** add the [[event-envelope]]: `run_id`, `session_id`, `seq` and `ts` on every event, plus a JSON-safe `error`. This was the most time-sensitive step.
4. **Defer** moving the messaging adapters onto the SessionManager (#114 item 2).

## Revisit (2026-09-24): the decision played out differently

The revisit trigger fired: #101 and #102 merged **without** steps 2 and 3 being done first — they went in with the Ossuary wave (#123, 2026-09-24) rather than waiting on the extraction. As a result:

- The serve surface on `origin/main` still has the single global queue (`src/serve/prompts.ts:36-73@db5c797`) and one Agent for all sessions; the [[event-envelope]] has not landed, so `event` notifications still wrap raw `AgentEvent` values with only a `session_id` (`src/serve/protocol.ts:150-153@db5c797`).
- Ossuary panes already read some payload fields — `event_blocks` handles `tool_call_end.result`, `compress_end.summary_chars` and `error.error` (`apps/ossuary/src/chat/event_blocks.ts:6-20@db5c797`) — so the predicted pane-by-pane rewrite cost is now real but bounded: the panes read a handful of fields, not the whole payload.
- The work itself did not vanish: extracting the SessionManager and landing the envelope together is #114 item 2, tracked with the same revisit trigger.

This page is kept for the record; its status is now **superseded by events** — the merge-order plan is no longer the operative constraint, and #114 item 2 is where the remaining work lives.

## Consequences

- Ossuary was not blocked: its client depends only on #80's method names, which were already merged and stable.
- The event shape settled *after* some panes shipped, so an envelope change now means touching [[ossuary]]'s `event_blocks` and its parse path — bounded, but no longer free.
- 10 NPCs still wait behind one global queue until #114 item 2 lands.
- #82 and #83 may move back to In Progress on the kanban until the SessionManager and envelope land.

## Alternatives considered

- **Retarget #81–#84 as gateway-adapter work now.** Rejected: the whole Ossuary track would have waited on a gateway refactor.
- **Land everything as it is.** Rejected at decision time; in the event, this is effectively what happened, with the follow-up tracked in #114 item 2.

Related: [[0001-gateway-as-hub]], [[lich-serve]], [[ossuary]], [[event-envelope]].