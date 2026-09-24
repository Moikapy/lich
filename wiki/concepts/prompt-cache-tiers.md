---
title: Prompt-cache tiers (byte-stable system prompt)
created: 2026-09-23
updated: 2026-09-23
type: concept
tags: [context, providers, performance, hermes]
sources: [raw/audits/2026-09-23-hermes-vs-lich.md, raw/audits/2026-09-23-core-engine-audit.md]
confidence: high
---

# Prompt-cache tiers

Providers cache identical prompt **prefixes**. Anthropic does this with explicit `cache_control` breakpoints; OpenAI does it automatically. A prefix that changes by even one byte misses the cache.

**How Hermes handles it** (`agent/system_prompt.py`, `agent/prompt_caching.py`): ^[raw/audits/2026-09-23-hermes-vs-lich.md]
- It builds the system prompt **once per session**, in three tiers:
  - **stable:** identity and tool guidance
  - **context:** project files such as `AGENTS.md` and `CLAUDE.md`
  - **volatile:** the skills index, a memory snapshot, time and environment
- It never changes the prompt mid-session, except during compaction.
- Memory written mid-session appears only in the next session.
- It places 4 breakpoints: the system prefix plus the last 3 messages, all with one TTL.

**How Lich stands:**
- No `cache_control` (`anthropic.ts:192-201@77bc148`).
- The system prompt is a single string.
- Compression rewrites the history prefix, which defeats caching anyway. ^[raw/audits/2026-09-23-core-engine-audit.md]

**The trade-off:** you give up freshness (new memories wait until the next session) in exchange for large savings in cost and latency. The savings matter most for long NPC conversations and long coding sessions.

**For Lich:**
1. Add the prompt hooks (`build_system_prompt`, `before_llm_call`).
2. Build the prompt in tiers.
3. Add Anthropic breakpoints.
4. Make compression keep the cached prefix intact where it can.

This is phase 5 in [[roadmap-issues]].

Related: [[memory-vs-skills]], [[lich-providers]], [[hermes-agent]].
