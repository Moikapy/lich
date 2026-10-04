---
title: LLM wiki pattern
created: 2026-09-23
updated: 2026-09-23
type: concept
tags: [memory, process, research]
sources: [raw/external/llm-wiki-karpathy-summary.md, raw/external/hermes-llm-wiki-skill.md]
confidence: high
---

# LLM wiki pattern

This is Karpathy's alternative to RAG. Instead of re-deriving answers from source chunks on every query, an LLM **compiles** the sources into a persistent, interlinked markdown wiki and keeps it current. Cross-references and flagged contradictions accumulate, so the wiki becomes more useful as sources are added. ^[raw/external/llm-wiki-karpathy-summary.md]

**Structure** (as in Hermes' `llm-wiki` skill): ^[raw/external/hermes-llm-wiki-skill.md]
- `raw/`: immutable sources, stamped with a hash
- agent-owned pages: entities, concepts, comparisons, queries
- `SCHEMA.md`: the rules
- `index.md`: the catalog
- `log.md`: append-only history
- Operations: **orient**, **ingest**, **query**, **lint**

**Division of labour:** the human curates the sources and directs the analysis. The agent summarizes, cross-references, files and keeps everything consistent.

**How this wiki adapts it:**
- a `decisions/` layer with revisit triggers
- `path:line@sha` code citations
- an explicit boundary against docs, code and the kanban

See [[0006-in-repo-llm-wiki]].

**Uses inside Lich (the product):**
- a lore wiki for game worlds ([[npc-memory-namespaces]])
- an engine knowledge wiki for agents that code games ([[memory-vs-skills]])

The owner has used this pattern before, in `~/.kapy/wiki` (the "grimoire").

Related: [[llm-wiki-vs-docs]], [[hermes-agent]].
