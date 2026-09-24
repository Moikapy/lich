---
title: Lich providers and failover
created: 2026-09-23
updated: 2026-09-23
type: entity
tags: [providers, runtime, performance]
sources: [raw/audits/2026-09-23-core-engine-audit.md]
confidence: high
---

# Lich providers

`src/providers/*` has three hand-written HTTP clients: `openai_compat`, `anthropic` and `ollama`. None of them uses a vendor SDK, and each takes an injectable `fetch`. `router.ts` and `failover.ts` try providers in config order:
- `rate_limit` and `network` errors get 3 attempts with deterministic backoff.
- `auth`, `overflow` and `bad_request` errors move to the next provider immediately.

## Strengths

- The errors are classified correctly.
- Consecutive tool results are merged into one Anthropic user turn (`anthropic.ts:203-233@77bc148`).
- v0.9.0 adds `provider_content` so Anthropic thinking blocks round-trip.

## Gaps (open on v0.9.0)

- **No streaming.** Ollama sends `stream:false`; see [[streaming-deltas]].
- **`ChatOptions` is only `{temperature, max_tokens, signal, think}`.** There is no `tool_choice`, `response_format` or stop sequences. This matters most for small local models; see [[action-terminal-mode]].
- **No `cache_control`.** See [[prompt-cache-tiers]].
- **Content is string-only,** so there is no vision.
- **An `overflow` error fails over** instead of compressing and retrying.
- **P-9:** an OpenAI response with no tool id becomes `""`, the "jitter" is deterministic, and there is no memory of provider health.
- **About 150 lines of duplicated HTTP and error helpers** across the three clients. This is the one DRY fix recommended in [[0004-dry-policy]].

Related: [[lich-agent-loop]], [[lich-vs-hermes]].
