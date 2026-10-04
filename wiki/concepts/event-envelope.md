---
title: Event envelope (run/session-scoped events)
created: 2026-09-23
updated: 2026-09-25
type: concept
tags: [events, core, serve, ossuary]
sources: [raw/audits/2026-09-23-core-engine-audit.md, "#113", "#134"]
confidence: high
---

# Event envelope

**Landed in #134 (0.10.0):** every public `AgentEvent` carries
`{ run_id, session_id, seq, ts }` plus the payload (`src/agent/events.ts`).
`error` is JSON-safe `{ kind, message }`. `run_start` / `run_end` bookend each
`Agent.run`. Aborts emit `run_end` with `stopped_reason: "aborted"`, not
`type: "error"`. Per-run `on_event` in `AgentRunOptions` is the preferred
subscription for concurrent runs; serve uses it exclusively.

**Why it mattered:** [[ossuary]] panes render from serve `event` notifications.
[[0002-serve-pr-merge-path]] planned the envelope before #102 merged; #101/#102
shipped without it. #134 closes that gap so concurrent sessions can be told
apart and the wire stays JSON-safe.

`seq` is monotonic per run. `session_id` defaults to the transcript handle id
when callers omit it. Slim `llm_end` (usage-only) remains future work under
streaming.

Related: [[lich-agent-loop]], [[lich-serve]], [[streaming-deltas]].
