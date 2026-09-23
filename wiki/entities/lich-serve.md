---
title: lich serve (JSON-RPC over WebSocket)
created: 2026-09-23
updated: 2026-09-23
type: entity
tags: [serve, surface, ossuary, games]
sources: [raw/audits/2026-09-23-game-surface-audit.md, raw/issues/issue-79.md, "#113"]
confidence: medium
---

# lich serve

`lich serve` is a headless JSON-RPC 2.0 server over WebSocket. It owns the Agent and is meant to be the control surface for [[ossuary]] (epic #79).
- Protocol types (#80) are merged on origin: `src/serve/protocol.ts@bad1243`.
- The implementation is in open PRs: #99 (transport and health, #81), #101 (sessions, #82), #102 (prompt and events, #83), #103 (CLI, #84).

## Protocol today

- **Methods:** `health`, `session.create/list/clear/resume` and `prompt.submit/abort`.
- **Notifications:** `event` forwards each `AgentEvent` unchanged.
- **Access:** loopback only, with a random token printed on the stdout boot line. Batch requests are rejected. ^[raw/audits/2026-09-23-game-surface-audit.md]

## Problems found in the audit

- **One global run queue** (`run_tail` in `prompts.ts`, PR #102). This is needed because `agent.events` is process-wide, and it means 10 NPCs take 10× the latency.
- **One Agent for all sessions.** There is no per-session prompt, tools or model; `session.create` takes only `{label, source}`.
- **No lifecycle for sessions.** Sessions are never evicted and can't be deleted, and any client can drive any session.
- **Inherits the CLI config,** whose `tools_enabled` defaults to `"all"`. An embedded client therefore gets `terminal` and `write_file`.
- **Missing features:** token deltas, client-executed tools, deadlines and protocol versioning.

## Direction

[[0001-gateway-as-hub]] makes serve the gateway's **interactive adapter**. [[0002-serve-pr-merge-path]] covers the order of work:
1. Merge #99 and #103 as they are.
2. Extract a shared SessionManager and add the [[event-envelope]] before #101 and #102 merge.

Game features it will need: [[client-executed-tools]], [[streaming-deltas]], [[action-terminal-mode]].

Related: [[lich-gateway]], [[game-transports]].
