---
title: lich serve (JSON-RPC over WebSocket)
created: 2026-09-23
updated: 2026-09-25
type: entity
tags: [serve, surface, ossuary, games]
sources: [raw/audits/2026-09-23-game-surface-audit.md, raw/issues/issue-79.md, "#113", "#134"]
confidence: medium
---

# lich serve

`lich serve` is a headless JSON-RPC 2.0 server over WebSocket. It owns the Agent and is meant to be the control surface for [[ossuary]] (epic #79).
- Protocol types (#80) and the transport/sessions/prompt/CLI path (#99–#103) landed with the Ossuary wave (#123). #134 adds the [[event-envelope]] and per-session `SessionManager`.

## Protocol today

- **Methods:** `health`, `session.create/list/clear/resume` and `prompt.submit/abort` (`src/serve/protocol.ts`).
- **Notifications:** `event` is `{ session_id, event }` where `event` is an enveloped `AgentEvent` (`run_id`, `session_id`, `seq`, `ts`, …). Outer `session_id` matches the envelope. Serve subscribes via per-run `on_event`, not the process-wide bus.
- **Access:** loopback only, with a random token printed on the stdout boot line. Batch requests are rejected.

## Concurrency

- Runs are queued **per session** via `create_session_manager` (`src/session/manager.ts`); different sessions overlap. Same-session submits stay serial (abort-while-queued still works).
- Still **one Agent** for all sessions — no per-session prompt, tools, or model (`session.create` takes `{label, source}`).

## Remaining gaps

- No lifecycle beyond LRU-capped in-memory bags; transcripts live on disk forever; any client with the token can drive any session.
- Inherits the CLI config (`tools_enabled` defaults to `"all"`).
- Missing features: token deltas, client-executed tools, deadlines and protocol versioning.
- Gateway Discord/Twitch/Telegram adapters still need to adopt SessionManager (#114 remainder).

## Direction

[[0001-gateway-as-hub]] makes serve the gateway's **interactive adapter**. [[0002-serve-pr-merge-path]]'s pre-merge envelope step was deferred; #134 landed the extraction. Adapter migration stays on #114.

Game features ahead: [[client-executed-tools]], [[streaming-deltas]], [[action-terminal-mode]].

Related: [[lich-gateway]], [[game-transports]], [[0002-serve-pr-merge-path]], [[event-envelope]].
