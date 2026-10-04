---
title: Lich gateway (the familiars)
created: 2026-09-23
updated: 2026-09-23
type: entity
tags: [gateway, surface, security, npc]
sources: [raw/audits/2026-09-23-game-surface-audit.md, raw/audits/2026-09-23-core-engine-audit.md, "#113"]
confidence: high
---

# Lich gateway

The gateway lives in `src/gateway/*`. It routes messages from webhook, Telegram, Discord and Twitch into **one shared Agent**. In the project's lore these adapters are called "familiars".

## Pieces

- **`bus.ts`** runs the messages of one `platform:chat_id` in order, while different ids run concurrently (`bus.ts:51-66@77bc148`). History is in memory only: 40 messages per conversation and at most 200 conversations (`bus.ts:27-28`). Eviction is by insertion order (G-10, still open).
- **`access.ts`** gives chat platforms a read-only toolset by default, plus per-platform allowlists (`access.ts:10-18`).
- **`webhook.ts`** handles `POST /message` with `{text, chat_id, user_id}` and returns `{reply, usage:null}`.
  - It binds `127.0.0.1` by default; a non-loopback bind requires the `x-lich-token` header.
  - It caps request bodies at 1 MB (v0.9.0).
  - A failed run still returns HTTP 200.
- **`runner.ts`** creates one Agent that is shared by every adapter (`runner.ts:16-21`).

## Why it matters

The per-chat queue in `bus.ts` is exactly the scheduling that many NPCs need. The read-only default in `access.ts` is also closer to a game-safe default than the CLI's `tools_enabled: "all"`. That is why the proposal is to make the gateway the hub; see [[0001-gateway-as-hub]].

## Gaps

- It is text in, text out: no events, no streaming, no tools executed by the client.
- One persona per process, because every adapter shares one Agent.
- The webhook always returns `usage: null`, and failures come back as HTTP 200.
- `AgentConfig` embeds the gateway's config schema. This is a layering violation; see [[subpaths-vs-packages]].
- **Stale docs:** `docs/user-guide/godot.md:33,151` and `examples/persona_orchestrator/README.md:42` say it binds `0.0.0.0`. The code binds `127.0.0.1`.

Related: [[lich-serve]], [[game-transports]], [[embedded-safety-profile]].
