---
title: Lich providers and failover
created: 2026-09-23
updated: 2026-10-02
type: entity
tags: [providers, runtime, performance]
sources: [raw/audits/2026-09-23-core-engine-audit.md, raw/audits/2026-10-02-decision-models-ollama-research.md, "#148", "#152"]
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

## Ollama: local and ollama.com cloud

- The Ollama client defaults to `http://localhost:11434` and needs no key. When `api_key` or `api_key_env` resolves, it sends `Authorization: Bearer` (`src/providers/ollama.ts:137-165@e9bdd82`). That is enough for Ollama's hosted models: `LICH_BASE_URL=https://ollama.com` plus `LICH_API_KEY_ENV=OLLAMA_API_KEY`. Not yet smoke-tested; tracked in #148.
- The documented local default is `qwen3:8b` (the setup wizard writes it too; `src/setup_wizard.ts:16@d28dd0b`), replacing `llama3.2` (3B), which is weak at tool calling. The README documents Ollama cloud via `LICH_BASE_URL` plus `LICH_API_KEY_ENV` (`README.md:160-181@d28dd0b`). Merged in #152.
- Ollama 0.35's decision endpoint (`/v1/systemone`) is a different API from `/api/chat`; see [[decision-models]].

## Gaps (open on v0.9.0)

- **No streaming.** Ollama sends `stream:false`; see [[streaming-deltas]].
- **`ChatOptions` is only `{temperature, max_tokens, signal, think}`.** There is no `tool_choice`, `response_format` or stop sequences. This matters most for small local models; see [[action-terminal-mode]].
- **No `cache_control`.** See [[prompt-cache-tiers]].
- **Content is string-only,** so there is no vision.
- **An `overflow` error fails over** instead of compressing and retrying.
- **P-9:** an OpenAI response with no tool id becomes `""`, the "jitter" is deterministic, and there is no memory of provider health.
- **About 150 lines of duplicated HTTP and error helpers** across the three clients. This is the one DRY fix recommended in [[0004-dry-policy]].

Related: [[lich-agent-loop]], [[lich-vs-hermes]].
