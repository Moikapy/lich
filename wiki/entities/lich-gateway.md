---
title: Lich gateway (the familiars)
created: 2026-09-23
updated: 2026-10-19
type: entity
tags: [gateway, surface, security, npc]
sources: [raw/audits/2026-09-23-game-surface-audit.md, raw/audits/2026-09-23-core-engine-audit.md, "#113", "#174", "#178", "#180", "#194", "#204"]
confidence: high
---

# Lich gateway

The gateway lives in `src/gateway/*`. It routes messages from webhook, Telegram, Discord and Twitch into **one shared Agent**. In the project's lore these adapters are called "familiars". Code below is pinned at v0.10.0.

## Pieces

- **`bus.ts`** queues runs on the shared `SessionManager` keyed by `platform:chat_id`: one chat runs in order, different chats run concurrently (`src/gateway/bus.ts:67@0826623`, `src/session/manager.ts:12@0826623`, #174). Serve uses the same manager ([[lich-serve]]).
  - History is in memory only: 40 messages per conversation, at most 200 conversations (`src/gateway/bus.ts:32-33@0826623`). Eviction is least-recently-used; the cap is enforced again on store, since concurrent new chats can each pass the load-time check (`src/gateway/bus.ts:108@0826623`). G-10 is fixed.
  - A failed turn keeps the turns that finished (`history_after_run_error`). If a new chat evicted this conversation mid-run and nothing was kept, the loaded history is put back (`src/gateway/bus.ts:95@0826623`, #180).
  - `/start` becomes `hello` only on Telegram (`/start`, `/start@bot`, `/start <payload>`; not `/started`) (`src/gateway/bus.ts:156@0826623`).
  - The history cap keeps tool-heavy windows and opens a user-less window with a stub user turn (#142, `src/gateway/bus.ts:171@0826623`).
- **`access.ts`** builds one `GatewayPolicy` at startup: `tools_enabled` (a read-only toolset by default) and `allows(platform, chat, user)`. Telegram, Discord and Twitch deny everyone until an allowlist has an entry (`src/gateway/access.ts:28,55@0826623`, #178). The runner hands the policy's toolset to the shared agent (`src/gateway/runner.ts:17@0826623`).
- **Adapter capabilities:** every adapter declares `capabilities: {kind: "text", max_reply_chars?}` (`src/gateway/types.ts:31@0826623`, #178). Discord splits at 2000, Telegram 4096, Twitch 450; the webhook has no cap. This is the first step of [[0001-gateway-as-hub]]'s "adapters declare capabilities".
- **`webhook.ts`** handles `POST /message` with `{text, chat_id, user_id}` and returns the reply with the run's real `usage`. A failed run returns **HTTP 502** with the sanitized error (`src/gateway/webhook.ts:110@0826623`, #174).
  - It binds `127.0.0.1` by default; a non-loopback bind requires `LICH_GATEWAY_TOKEN`, sent as `x-lich-token`.
  - It caps request bodies at 1 MB.
- **Discord:** a bare bot mention (`<@id>` or `<@!id>`) strips to empty text and is ignored rather than starting an empty turn (`src/gateway/discord.ts:208@0826623`, #194).
- **Twitch:** `parse_irc_line` treats `001` / `GLOBALUSERSTATE` as the welcome only in the command position, so chat text containing those tokens is not misread (`src/gateway/twitch.ts:216@0826623`, #204).
- **`runner.ts`** creates one Agent shared by every adapter. Shutdown stops all adapters and waits for them, bounded at 5 s, before closing the bus and agent (`src/gateway/runner.ts:115-140@0826623`, #174).

## Why it matters

The per-chat queue is exactly the scheduling that many NPCs need, and since #174 it is the same `SessionManager` serve uses. The read-only default in `access.ts` is also closer to a game-safe default than the CLI's `tools_enabled: "all"`. That is why the proposal is to make the gateway the hub; see [[0001-gateway-as-hub]].

## Gaps

- It is text in, text out: no events (runs pass no `on_event`; see [[event-envelope]]), no streaming, no tools executed by the client.
- One persona per process, because every adapter shares one Agent. `GatewayPolicy` is not yet a per-conversation Profile ([[runtime-profile-session]]).
- Each run opens a new session file with the full history, so files are supersets ([[lich-sessions]]).
- `AgentConfig` embeds the gateway's config schema. This is a layering violation; see [[subpaths-vs-packages]].

Related: [[lich-serve]], [[game-transports]], [[embedded-safety-profile]].
