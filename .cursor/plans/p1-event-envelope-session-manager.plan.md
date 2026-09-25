---
name: "P1 event envelope SessionManager"
overview: "Implementation plan for #134 (Part of #113): add a run/session-scoped event envelope, replace serve’s global run_tail with a SessionManager, and update Ossuary’s event parse path."
todos:
  - id: envelope-types
    content: "Define EnvelopedAgentEvent + JSON-safe error; emit run_start/run_end; add on_event to run options"
    status: pending
  - id: session-manager
    content: "Extract SessionManager with per-session queues; wire serve prompts to it"
    status: pending
  - id: serve-wire
    content: "Serve event notifications carry envelope; keep session_id routing stable for clients"
    status: pending
  - id: ossuary-parse
    content: "Update Ossuary WireAgentEvent / event_blocks / tests for envelope + safe error"
    status: pending
  - id: tests-ci
    content: "Tests for envelope fields, concurrent session isolation, serve + ossuary CI green"
    status: pending
isProject: false
---

# P1: Event envelope + SessionManager (#134)

Parent: [#113](https://github.com/Moikapy/lich/issues/113). Sibling: [#133](https://github.com/Moikapy/lich/issues/133) (P0 hygiene, parallel).

## Goal

Make serve/Ossuary safe for concurrent sessions and a stable UI contract:

1. Every agent event is **enveloped** (`run_id`, `session_id`, `seq`, `ts`, `type`, payload).
2. Runs are queued **per session**, not globally (`run_tail` today).
3. Ossuary still renders chat correctly after the wire change.

## Current anchors

| Area | Today | Target |
| --- | --- | --- |
| Events | Bare `AgentEvent` in [`src/agent/events.ts`](src/agent/events.ts); `error: unknown` | Envelope wrapper; `error: { kind, message }`; `run_start` / `run_end` |
| Fan-out | Process-wide `agent.events` | Per-run `on_event` preferred; global bus may remain for legacy but serve must not rely on it for routing |
| Serve queue | Global `run_tail` in [`src/serve/prompts.ts`](src/serve/prompts.ts) | `SessionManager.run(session_id, fn)` serializes only that session |
| Wire | `{ session_id, event: AgentEvent }` in [`src/serve/protocol.ts`](src/serve/protocol.ts) | `event` is enveloped (session_id may stay outer for routing; must not disagree with envelope) |
| Ossuary | [`apps/ossuary/src/chat/event_blocks.ts`](apps/ossuary/src/chat/event_blocks.ts) switches on `event.type` | Accept envelope; read payload fields; JSON-safe error text |

## Design (concrete)

### Envelope shape

```ts
type AgentErrorPayload = { kind: string; message: string };

type EventEnvelope<T extends { type: string }> = {
  run_id: string;
  session_id: string;
  seq: number;
  ts: number; // Date.now()
} & T;
```

- Assign `run_id` at the start of each `Agent.run` (crypto random or ulid-style).
- Monotonic `seq` per run (or per session — pick **per run** for simpler tests).
- Aborts: emit `run_end` with a stopped reason, **not** `type: "error"`.
- Slim `llm_end` only if needed for JSON size; prefer not expanding scope — keep payload, ensure serializable.

### SessionManager

New module e.g. [`src/session/manager.ts`](src/session/manager.ts) (or `src/serve/session_manager.ts` if keep serve-local first):

- `enqueue(session_id, task): Promise<T>` — per-id promise tail (same pattern as current `run_tail`, keyed by id).
- Optional: track inflight AbortControllers (can stay in prompt service initially).
- Serve `create_serve_prompt_service` uses manager instead of module-level `run_tail`.
- **Do not** migrate Discord/Twitch/Telegram in this PR (#114 remainder).

### Agent API

- Extend run options with `session_id?: string` and `on_event?: (e: EnvelopedAgentEvent) => void`.
- When `on_event` is set, serve subscribes only via that path for the run (avoids cross-talk even if global `agent.events` still fires).
- If global emit remains for TUI/gateway, include envelope fields there too so one shape everywhere.

### Ossuary

- Update `WireAgentEvent` / parsers to unwrap envelope (or treat top-level as enveloped).
- `error_text` accepts `{ kind, message }` objects.
- Keep UI behaviour for `tool_call_end`, `compress_end`, `error` notices.

## PR slicing (prefer one PR if small; else two)

1. **Core:** envelope types + loop/agent emit + unit tests.
2. **Serve + Ossuary:** SessionManager + wire + client parse + integration tests.

If split: land (1) first with backwards-compatible dual emit only if required; prefer a **single PR** with `Closes #134` to avoid a half-migrated wire.

## Test plan

```bash
bun x tsc --noEmit
node node_modules/vitest/vitest.mjs run test/serve_prompts.test.ts test/serve_transport.test.ts
# plus new envelope / session-manager unit tests
cd apps/ossuary && bun run typecheck && node node_modules/vitest/vitest.mjs run
node wiki/scripts/lint.mjs  # if wiki pages updated
```

- Two sessions: overlapping submits → events only notify the matching `session_id` / `run_id`.
- Abort still cancels the correct session (regression for #128 behaviour).

## Docs / wiki on merge

- Update [`wiki/concepts/event-envelope.md`](wiki/concepts/event-envelope.md) + [`wiki/entities/lich-serve.md`](wiki/entities/lich-serve.md); log line; pin SHAs to merge commit.
- Note in #114 item 2 that **extraction** landed; adapter migration still deferred.

## Out of scope

Runtime/Profile/Session split, #117, streaming, client-executed tools, gateway adapter rebuild, package exports.
