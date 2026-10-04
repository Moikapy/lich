---
title: "0006: In-repo LLM wiki (wiki/)"
created: 2026-09-23
updated: 2026-09-23
type: decision
tags: [decision, process, memory, docs]
sources: [raw/issues/issue-113.md, raw/external/llm-wiki-karpathy-summary.md, raw/external/hermes-llm-wiki-skill.md]
status: accepted
issue: "#113"
revisit_when: "After ~1 month of use: is the wiki consulted at session start and updated on events, or has it gone stale? Also when #114 item 7 (MemoryStore) starts"
---

# 0006: In-repo LLM wiki

## Context

The docs say what Lich does, and the kanban says what to do next. Nothing held **what we know and why**:
- Hermes research lived in subagent reports and was lost when the session ended.
- Architecture decisions were buried in #113 comments.
- Review findings sat in 13 untracked `REVIEW-pr*-herdr.md` files.
- Plans were in `.cursor/plans/`.
- Engine facts were rediscovered every session.

The owner already uses the LLM wiki pattern for Kapy (`~/.kapy/wiki`), and Hermes ships an `llm-wiki` skill. ^[raw/external/hermes-llm-wiki-skill.md]

## Decision

Adopt the [[llm-wiki-pattern]] as **`lich/wiki/`, inside the repo** (#113 Addendum 3):
- `raw/`: immutable, sha256-stamped sources
- pages: entities, concepts, comparisons, decisions, queries
- `SCHEMA.md`, `index.md`, and a `log.md` that is only appended to
- the project skill `.claude/skills/lich-wiki/`

Lich's additions to the pattern:
- `decisions/` pages with revisit triggers
- `path:line@sha` code citations
- an explicit boundary with docs, code and the kanban

**Guardrails:**
- Docs and code stay the source of truth for behaviour. The wiki never copies card status.
- Update on events (PR merged, review done, research done, decision made), not continuously.
- `wiki/scripts/lint.mjs` checks structure. Agents check by judgment for stale SHAs and revisit triggers that have fired.
- Not shipped: the npm `files` whitelist excludes `wiki/`, and VitePress doesn't include it.

## Consequences

- Every tool (Claude Code, Cursor, Herdr, Hermes, Lich) and every worktree shares one project memory.
- A new session orients from `index.md` instead of re-running expensive research.
- The wiki doubles as the prototype for Lich's own memory format ([[npc-memory-namespaces]], #114 item 7).
- The cost is maintenance discipline. Without event-driven updates and lint, it becomes a fourth stale source.

## Alternatives considered

- **Keep it in `~/.kapy/wiki`.** Rejected: that is personal, invisible to collaborators and to agents in worktrees, and mixes projects.
- **Put it in `docs/`.** Rejected: it would ship to users and mix rationale and history into product docs. See [[llm-wiki-vs-docs]].
- **RAG over the repo.** Rejected: it re-derives answers every time, and never accumulates cross-references or flagged contradictions.

## Revisit when

After about a month of use, check whether sessions actually orient from the wiki and whether lint stays clean. Revisit the format once #114 item 7 (`MemoryStore`) starts.

Related: [[0005-kanban-and-single-issue-workflow]], [[memory-vs-skills]].
