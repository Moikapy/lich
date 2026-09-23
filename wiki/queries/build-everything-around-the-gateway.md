---
title: "Query: could everything be built around the gateway?"
created: 2026-09-23
updated: 2026-09-23
type: query
tags: [gateway, serve, decision]
sources: [raw/issues/issue-113.md, raw/audits/2026-09-23-game-surface-audit.md, raw/audits/2026-09-23-hermes-vs-lich.md]
confidence: high
---

# Could we do this if everything was built around the gateway?

*Asked by the maintainer on 2026-09-23, after the #113 audit. Posted to #113 as Addendum 1, and recorded as [[0001-gateway-as-hub]].*

## Short answer

**Yes.** This is essentially how [[hermes-agent]] is built: its gateway owns sessions, one agent per session, delivery and cron ticks. For Lich it is arguably cleaner than keeping [[lich-serve]] as a separate system. ^[raw/audits/2026-09-23-hermes-vs-lich.md]

## Why the gateway fits

A gateway is a session router, a message bus and a set of adapters. Lich's already has the two pieces games need most: ^[raw/audits/2026-09-23-game-surface-audit.md]
- `bus.ts` runs each chat in order and different chats concurrently. That is the right scheduling for many NPCs, and it avoids serve's single global `run_tail` queue.
- `access.ts` defaults to read-only tools, which is closer to a game-safe default than the CLI's `tools_enabled: "all"`.

## What has to change

The internal contract widens from *text in, text out* to a **two-way event stream**.

```
Gateway core: SessionManager (from bus.ts) · Runtime · Profiles (from access.ts) · Policy · Scheduler
Adapters by capability:
  text         telegram, discord, twitch, webhook   → events folded into one reply
  streaming    SSE / WebSocket                      → text_delta, tool events
  interactive  WebSocket JSON-RPC (today's serve)   → client tools, abort, approvals, observations
```

After this change:
- Serve becomes the interactive adapter.
- The engine SDKs, [[ossuary]] and eventually the TUI become its clients.
- The file bus is replaced by [[client-executed-tools]].
- [[persona-orchestrator-example]] collapses into Profiles and Sessions ([[runtime-profile-session]]).

## Trade-offs

1. **The library must stay underneath.** The gateway sits on top of it; it doesn't replace it. Web and Node games, tests and embedders keep using it in process.
2. **Local use pays a loopback hop.** Mitigate this with an in-process gateway mode for the TUI and one-shot CLI.
3. **One long-lived process holds every session.** That makes these required:
   - session ownership tied to each connection
   - per-profile tool limits
   - hooks that fail closed
   - `tools_enabled` that also covers plugin tools
4. **Adapters must declare their capabilities.** A Telegram chat can't answer `tool.invoke`, so a profile that needs client tools must be refused on text adapters.
5. **The protocol needs a version number and a capability handshake.**

## Follow-up

The maintainer then asked what to do with the open serve PRs. The answer is in [[0002-serve-pr-merge-path]].

Related: [[lich-gateway]], [[game-transports]].
