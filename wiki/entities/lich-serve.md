---
title: lich serve (JSON-RPC over WebSocket)
created: 2026-09-23
updated: 2026-10-19
type: entity
tags: [serve, surface, ossuary, games]
sources: [raw/audits/2026-09-23-game-surface-audit.md, raw/issues/issue-79.md, "#113", "#134", "#168", "#183", "#184", "#186", "#199"]
confidence: medium
---

# lich serve

`lich serve` is a headless JSON-RPC 2.0 server over WebSocket. It owns the Agent and is meant to be the control surface for [[ossuary]] (epic #79).
- Protocol types (#80) and the transport/sessions/prompt/CLI path (#99–#103) landed with the Ossuary wave (#123). #134 adds the [[event-envelope]] and per-session `SessionManager`. Code below is pinned at v0.10.0.

## Protocol today

- **Methods:** `health`, `session.create/list/clear/resume` and `prompt.submit/abort` (`src/serve/protocol.ts:10@0826623`).
- **`health`** returns `protocol_version` (`SERVE_PROTOCOL_VERSION = 1`, bumped only on breaking changes) and `capabilities: {methods, notifications}`. `prompt.*` are listed only when the server has an agent (`src/serve/protocol.ts:31@0826623`, `src/serve/rpc.ts:86-95@0826623`, #184). Additive features show up in `capabilities`, not in the version.
- **Notifications:** `event` is `{ session_id, event }` where `event` is an enveloped `AgentEvent` (`run_id`, `session_id`, `seq`, `ts`, …). Outer `session_id` matches the envelope. Serve subscribes via per-run `on_event`, not the process-wide bus.
- **Access:** loopback only (non-loopback `Host` is rejected before the token check), with a random token printed on the stdout boot line. Batch requests are rejected.

## Concurrency

- **Frames, per connection (#183):** each connection keeps one lane per session. Frames for one `params.session_id` are handled in order; different sessions and session-less frames (`health`, `session.list`) do not wait on each other, so replies can interleave and clients match them by JSON-RPC id (`src/serve/server.ts:236-292@0826623`).
  - `session.resume` is laned on `params.id`, so resuming a transcript waits for an in-flight submit that is still appending to it (#186).
  - `prompt.abort` is on no lane: waiting would deadlock a hung run with its own cancel. A queued submit arms its abort controller before it waits, so abort can cancel it before it starts.
- **Runs, across connections:** `prompt.submit` runs are queued per session via `create_session_manager` (`src/serve/prompts.ts:51@0826623`); different sessions overlap. The gateway shares this manager ([[lich-gateway]]).
- **Bags:** in-memory session bags are LRU-capped (default 32). An in-flight submit pins its bag so a `session.create` that overflows the cap cannot evict it mid-turn; the map may stay over the cap until a pin releases, and `unpin` spares the bag whose turn just finished (`src/serve/sessions.ts:142@0826623`, `src/serve/prompts.ts:96,140@0826623`, #199). Evicted transcripts stay on disk and can be resumed.
- **Abort (#168):** an aborted `prompt.submit` returns a reply only if this run wrote it, never the previous turn's, and the unanswered user line is dropped from the next turn's history (`src/serve/prompts.ts:193-210@0826623`, `src/agent/loop.ts:352-375@0826623`). Resume drops it too ([[lich-sessions]]).
- Still **one Agent** for all sessions — no per-session prompt, tools, or model (`session.create` takes `{label, source}`).

## Remaining gaps

- No lifecycle beyond LRU-capped in-memory bags; transcripts live on disk forever; any client with the token can drive any session.
- Inherits the CLI config (`tools_enabled` defaults to `"all"`).
- Missing features: token deltas, client-executed tools, deadlines.

## Direction

[[0001-gateway-as-hub]] makes serve the gateway's **interactive adapter**. [[0002-serve-pr-merge-path]]'s pre-merge envelope step was deferred; #134 landed the extraction, and #174 moved the gateway onto the same `SessionManager`. The remaining hub work is #144.

Game features ahead: [[client-executed-tools]], [[streaming-deltas]], [[action-terminal-mode]].

Related: [[lich-gateway]], [[game-transports]], [[0002-serve-pr-merge-path]], [[event-envelope]].
