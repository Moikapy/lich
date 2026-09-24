---
title: lich serve (JSON-RPC over WebSocket)
created: 2026-09-23
updated: 2026-09-24
type: entity
tags: [serve, surface, ossuary, games]
sources: [raw/audits/2026-09-23-game-surface-audit.md, raw/issues/issue-79.md, "#113"]
confidence: medium
---

# lich serve

`lich serve` is a headless JSON-RPC 2.0 server over WebSocket. It owns the Agent and is meant to be the control surface for [[ossuary]] (epic #79).
- Protocol types (#80) are merged on origin: `src/serve/protocol.ts@bad1243`. The transport, sessions, prompt RPC and CLI landed via #99–#103 (2026-09-23/24); the whole serve surface is on `origin/main` as of the Ossuary wave (#123).

## Protocol today

- **Methods:** `health`, `session.create/list/clear/resume` and `prompt.submit/abort` (`src/serve/protocol.ts:10-17@db5c797`).
- **Notifications:** `event` wraps each `AgentEvent` with a `session_id` (`src/serve/protocol.ts:150-153@db5c797`); the events themselves are still forwarded unchanged — the [[event-envelope]] has not landed.
- **Access:** loopback only, with a random token printed on the stdout boot line. Batch requests are rejected (`src/serve/rpc.ts:38@db5c797`). ^[raw/audits/2026-09-23-game-surface-audit.md]

## Problems found in the audit

- **One global run queue** (`run_tail` in `src/serve/prompts.ts:36-73@db5c797`). This is needed because `agent.events` is process-wide, and it means 10 NPCs take 10× the latency.
- **One Agent for all sessions.** There is no per-session prompt, tools or model; `session.create` takes only `{label, source}` (`src/serve/protocol.ts:81-86@db5c797`).
- **No lifecycle for sessions.** In-memory bags are now LRU-capped (32, evicting the oldest) but the transcripts live on disk forever; any client with the token can drive any session (`src/serve/sessions.ts:106-131@db5c797`).
- **Inherits the CLI config,** whose `tools_enabled` defaults to `"all"` (`src/agent/config.ts:107@db5c797`). An embedded client therefore gets `terminal` and `write_file`.
- **Missing features:** token deltas, client-executed tools, deadlines and protocol versioning.

## Direction

[[0001-gateway-as-hub]] makes serve the gateway's **interactive adapter**. [[0002-serve-pr-merge-path]]'s merge order has played out — the envelope and SessionManager steps were not done before #101/#102 merged — so the follow-ups live on #114 (item 2: SessionManager + [[event-envelope]] extracted together) and in #113's addenda. ^[raw/issues/issue-114.md]

Game features it will need: [[client-executed-tools]], [[streaming-deltas]], [[action-terminal-mode]].

Related: [[lich-gateway]], [[game-transports]], [[0002-serve-pr-merge-path]].