# Serve protocol

`lich serve` is the **desktop/TUI-grade** control surface for a headless Agent.
Ossuary (and later other rich clients) talk to it over loopback WebSocket
JSON-RPC. It is **not** the messaging gateway (`lich gateway` /
`POST /message`): gateway adapters deliver chat replies to Telegram, Discord,
Twitch, or an HTTP webhook; serve owns sessions, live `AgentEvent` streaming,
and abort.

This page documents the shared contract in
[`src/serve/protocol.ts`](../../src/serve/protocol.ts). Transport, listening,
and Agent wiring land in follow-up work — this note is types + intent only.

## Role in the system

```mermaid
flowchart LR
  Ossuary["apps/ossuary<br/>Electron + React"]
  Serve["lich serve<br/>WS JSON-RPC"]
  Agent["Agent + events"]
  Gateway["lich gateway<br/>messaging adapters"]

  Ossuary -->|"session / prompt / event"| Serve
  Serve --> Agent
  Gateway -.->|"not this contract"| Agent
```

- **Serve** — one process, loopback only, token-gated; server-owned
  conversation history; pushes `AgentEvent` as notifications.
- **Gateway** — multi-platform messaging bus; final text out, no Dockview-grade
  event stream. Do not build ossuary panels on the webhook.

## JSON-RPC shape

Standard JSON-RPC 2.0 envelopes (`jsonrpc: "2.0"`, `id` on requests/responses).
Requests use the locked method names below. Server → client notifications use
method `event` (no `id`).

## Methods (locked names)

| Method | Params | Result |
| --- | --- | --- |
| `health` | `{}` | `{ status: "ok", version }` (`LICH_VERSION`) |
| `session.create` | `{ label?, source }` | `{ session_id }` |
| `session.list` | `{}` | `{ sessions: [{ id, mtime_ms }, ...] }` |
| `session.clear` | `{ session_id }` | `{ session_id }` |
| `prompt.submit` | `{ session_id, text }` | reply, usage, `session_path`, `stopped_reason`, … |
| `prompt.abort` | `{ session_id }` | `{ session_id, aborted }` |

`session.resume` and other session RPCs may extend this map in later issues;
clients must not invent method names outside the locked set above until those
land.

## Notifications

| Method | Params |
| --- | --- |
| `event` | `{ session_id, event }` where `event` is an [`AgentEvent`](../../src/agent/events.ts) (same discriminated union the TUI consumes) |

Events are 1:1 with the in-process emitter — `turn_start`, `llm_*`,
`tool_call_*`, `final`, `error`, and the rest — so a Chat pane can mirror TUI
semantics without embedding `Agent` in Electron.

## What this issue does not include

- No WebSocket listener, port binding, or auth token.
- No `lich serve` CLI entry.
- No Agent construction or session file I/O.

Those belong to the serve track after protocol types compile and this doc is
in tree.
