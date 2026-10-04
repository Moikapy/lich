---
source_url: https://github.com/NousResearch/hermes-agent (shallow clone at bed0d535, read 2026-10-02)
ingested: 2026-10-02
sha256: f8d5f79f98e25390922eaf499b1478fab4a49c5b31b462a352d7c82deda9ad98
---
# Hermes: model roles, memory/embeddings and decision models (2026-10-02)

Read-only study of the Hermes Agent source (github.com/NousResearch/hermes-agent,
shallow clone at `bed0d535`, committed 2026-10-02) for #148 and #149. Paths are
relative to the Hermes repo root.

## Mixing models

- Main model: `model.default` in config, plus `fallback_model`, either one dict
  `{provider, model}` or an ordered chain list (`hermes_cli/config.py:1003`,
  validated in `_validate_fallback_model` at `:1147`).
- Side tasks ("auxiliary" models): each task has its own block
  `auxiliary.<task>` with `provider`, `model`, `base_url`, `api_key` or
  `key_env`, `timeout`, `reasoning_effort` and optional `max_concurrency`.
  Tasks documented in `cli-config.yaml.example` (Auxiliary Models section):
  vision, web_extract, tts_audio_tags, title_generation, session_search,
  compression, background_review (also curator, moa_reference).
- Provider `auto` means: main provider+model, then OpenRouter, Nous Portal,
  custom endpoint, native Anthropic, direct API-key providers
  (`agent/auxiliary_client.py` module docstring). `ollama-cloud` is a named
  provider choice (needs `OLLAMA_API_KEY`).
- Resolution priority: explicit call args > `auxiliary.<task>.*` config > auto
  (`_resolve_task_provider_model`, `agent/auxiliary_client.py:6077`).
  Entry point `call_llm(task=..., ...)` at `:7883`, with a per-task semaphore.
- Compression is summarized "using a fast/cheap model"; pin it with
  `auxiliary.compression.provider/model`. `resolve_compression_fast_lane`
  (`:6211`) certifies a non-reasoning fast lane only for an explicit match.
- Delegated subagents have their own `delegation.model` and
  `fallback_providers` chain.
- Size: `agent/auxiliary_client.py` is 8,256 lines, and the config still marks
  auxiliary overrides "Advanced — Experimental".

## Memory and embeddings

- Core has no embedding client. Memory is pluggable: ONE external provider at a
  time via `memory.provider`, plugins under `plugins/memory/<name>/`
  (byterover, holographic, mem0, openviking, retaindb).
- `MemoryProvider` ABC (`agent/memory_provider.py:84`): `is_available`,
  `initialize`, `system_prompt_block`, `prefetch` / `queue_prefetch`,
  `sync_turn`, `get_tool_schemas`, `handle_tool_call`, `shutdown`, plus
  optional `on_turn_start`, `on_session_end`, `on_pre_compress`,
  `on_delegation`, `on_memory_write`, config schema and backup paths.
- Embedders live inside providers: mem0's OSS registry lists OpenAI
  `text-embedding-3-small` (1536 dims) and Ollama `nomic-embed-text` (768 dims,
  default URL `http://localhost:11434`) (`plugins/memory/mem0/_oss_providers.py:15-17`).
- The built-in store is bounded `MEMORY.md` / `USER.md` frozen into the prompt.

## Decision models (Jev)

- Core has no decision-model support (no `systemone` / Jev code outside the
  plugin catalog and one dashboard reference).
- `plugin-catalog/` lists 14 community Jev entries, including: `jev`,
  `jev-typesafe` (tools `jev_evaluate`/`jev_check`/`jev_route`/`jev_score`),
  `jev-judge` (`pre_tool_call` gate, shadow by default, enforce escalates,
  JSONL per decision, fail-open), `jev-approvals` (smart-approval reviewer;
  failures fail closed to ESCALATE), `jev-skill-router` and
  `typesafe-skill-router` (`pre_llm_call`, names one skill, says nothing when
  nothing fits), `jev-effort-router` (`llm_request` middleware rewrites the
  Ollama Cloud request's model and reasoning effort per turn), `jev-cron-gate`
  (skip pointless cron runs, forced wake after N skips), `jev-curator`,
  `hermes-structured-aux-models` (routes approval / MCP sampling / compression
  aux tasks through decision calls, failing open to the aux provider), and
  MCP-server packages (`jev-model-router`, `jev-agent-router`,
  `jev-mcp-router`, `jev-memory-selector`).
- Shared traits: thresholds in code, shadow mode first, one JSONL line per
  decision, capped payloads, explicit egress disclosure in the catalog entry,
  fail open for routing, fail closed (escalate) for approvals.

## Plugin host features the decision/memory plugins rely on

- Hook names (`VALID_HOOKS`, `hermes_cli/plugins.py:109`): pre/post_tool_call,
  transform_terminal_output, transform_tool_result, transform_llm_output,
  pre/post_llm_call, stream observers, pre_verify, pre/post_api_request,
  api_request_error, pre/post_auxiliary_call, and more; plus `llm_request`
  middleware.
- Per-plugin settings: `ctx.get_config(key)` reads
  `plugins.entries.<plugin_id>.settings.<key>` (`hermes_cli/plugins.py:270`).
- Host-owned model access: `ctx.llm` (`agent/plugin_llm.py`) gives
  `complete` / `complete_structured` on the user's routing and auth; plugins
  never see keys; overrides are fail-closed behind
  `plugins.entries.<id>.llm.allow_*_override`. Backed by `call_llm`.
