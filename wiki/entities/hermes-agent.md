---
title: Hermes Agent (Nous Research)
created: 2026-09-23
updated: 2026-10-02
type: entity
tags: [hermes, research, ecosystem]
sources: [raw/audits/2026-09-23-hermes-vs-lich.md, raw/audits/2026-10-02-hermes-models-memory-decisions.md, "#149"]
confidence: high
---

# Hermes Agent

Hermes is the open-source Python agent that inspired Lich. It is installed locally at `~/.hermes/hermes-agent`, with the checkout's HEAD dated 2026-09-22.
- **Docs:** `website/docs/developer-guide/*.md` and the `AGENTS.md` file in each area.
- **Not docs:** `~/hermes` is empty, and `~/code/lich-hermes-docs` is an old Lich checkout (v0.7.0), not Hermes documentation.

## Code layout

Hermes pairs each facade with sibling files:
- `X.py` is the public face.
- `X_<topic>.py` files each own one topic.
- The agent loop is split into about 35 `agent/turn_*.py` phase files.

## Mechanisms worth studying

Details and file paths are in ^[raw/audits/2026-09-23-hermes-vs-lich.md].

- **A byte-stable system prompt with three tiers, plus 4 `cache_control` breakpoints.** See [[prompt-cache-tiers]].
- **Bounded `MEMORY.md` and `USER.md`** frozen into the prompt at session start, with **progressive disclosure** for skills (index in the prompt, `skill_view` on demand). See [[memory-vs-skills]].
- **Background review:** a forked agent that saves skills and memories every N turns. A **curator** archives stale skills.
- **SQLite with FTS5** and a `session_search` tool.
- **`delegate_task`:** depth 1, parallel batches, a list of blocked tools, and only a summary returned to the parent.
- **Named toolsets** with `check_fn` gating, resolved per session.
- **Approvals:** by pattern, by a human, or by an LLM; yolo mode; the gateway waits for the user's reply.
- **Interrupts per thread,** plus steer and redirect.
- **The gateway owns sessions and cron ticks.** This is the model for [[0001-gateway-as-hub]].
- **Trajectory output** (ShareGPT JSONL), `batch_runner.py`, **computer use** and **vision**.

## Models, memory and decision plugins (read at `bed0d535`, 2026-10-02)

A fresh clone of upstream was read for #148 and #149. Paths are in the Hermes repo. ^[raw/audits/2026-10-02-hermes-models-memory-decisions.md]

- **Model roles.** The main model has a `fallback_model` chain (`hermes_cli/config.py:1003`). Each side task (compression, vision, web extract, titles, session search, background review) has its own `auxiliary.<task>` provider and model, defaulting to "auto" (main model first) and resolved in `_resolve_task_provider_model` (`agent/auxiliary_client.py:6077`). That file is 8,256 lines, and overrides are still labelled experimental.
- **Embeddings live in memory plugins, not core.** One `MemoryProvider` at a time (`agent/memory_provider.py:84`); mem0 brings its own embedder, defaulting to Ollama `nomic-embed-text`.
- **Decision models are plugins only.** 15 dedicated community Jev plugins in `plugin-catalog/` (plus 4 broader plugins with Jev backends) route skills, gate tools, review approvals, pick per-turn model and effort, and skip idle cron runs. Shared rules: shadow mode first, one log line per decision, thresholds in code, capped payloads, egress disclosure, fail open for routing and fail closed for approvals. See [[decision-models]].
- **What those plugins stand on:** per-plugin `settings` (`ctx.get_config`, `hermes_cli/plugins.py:270`), host-owned model access (`ctx.llm`, keys never exposed, overrides fail closed) and hooks such as `pre_llm_call` (`hermes_cli/plugins.py:109`). Lich plans the same three in #149; see [[lich-plugins-and-hooks]].

## History note

The Atropos RL `environments/` directory was **removed** on 2026-05-15 in commit `5af672c753` (#26106). The old code is still useful as a reference when designing `lich env`: `git show 5af672c753^:environments/hermes_base_env.py`.

Related: [[lich-vs-hermes]], [[llm-wiki-pattern]] (Hermes ships an `llm-wiki` skill).
