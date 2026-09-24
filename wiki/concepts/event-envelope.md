---
title: Event envelope (run/session-scoped events)
created: 2026-09-23
updated: 2026-09-24
type: concept
tags: [events, core, serve, ossuary]
sources: [raw/audits/2026-09-23-core-engine-audit.md, "#113"]
confidence: high
---

# Event envelope

**Today:** `AgentEvent` is 11 bare event types, emitted synchronously on the shared `agent.events` (`events.ts:12-24@77bc148`). Because events carry no run or session id, concurrent runs on one Agent can't be told apart. `error: unknown` isn't JSON-serializable, yet serve forwards events to clients unchanged. There is also no per-run subscription (`on_event`). ^[raw/audits/2026-09-23-core-engine-audit.md]

**Proposal** (#113 §2c item 1):
```ts
{ run_id, session_id, seq, ts, type, ...payload }
```
- Add `run_start` and `run_end`.
- Make `error` JSON-safe: `{kind, message}`.
- Stop reporting aborts as `error`.
- Add a per-run `on_event` in `AgentRunOptions`.
- Slim down `llm_end`: send usage and finish reason, not the whole `ChatResult`.

**Why it mattered:** [[ossuary]] panes render from serve `event` notifications. [[0002-serve-pr-merge-path]] planned the envelope **before #102 merged**, but #101/#102 landed with the Ossuary wave (#123) without it, so the panes already read a few payload fields and an envelope change now touches their parse path. Landing it is #114 item 2.

Events are the UI contract of any harness. Every surface (TUI, desktop, game) renders from the event stream, so the envelope is the one format they all depend on. [[streaming-deltas]] extends the same envelope.

Related: [[lich-agent-loop]], [[lich-serve]].
