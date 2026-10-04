---
title: "Query: how does an LLM wiki help beyond the normal docs?"
created: 2026-09-23
updated: 2026-09-23
type: query
tags: [process, docs, memory]
sources: [raw/issues/issue-113.md, raw/external/llm-wiki-karpathy-summary.md, raw/external/hermes-llm-wiki-skill.md]
confidence: high
---

# How would an LLM wiki help beyond the docs we have?

*Asked by the maintainer on 2026-09-23. Posted to #113 as Addendum 3, and recorded as [[0006-in-repo-llm-wiki]].*

## Short answer

Each artifact answers a different question:
- **Docs:** what Lich does.
- **Kanban:** what to do next.
- **Wiki:** what we know, and why.

Before the wiki, that third kind of knowledge was scattered, and much of it was lost at the end of each session.

## The gap it fills (as of 2026-09-23)

| Knowledge | Lived in | Problem |
|---|---|---|
| Hermes internals | subagent reports | lost at the end of the session; re-researched each time (and the `lich-hermes-docs` mix-up could happen again) |
| Rationale for the gateway-as-hub and subpath decisions | comments on #113 | buried in threads, never brought together |
| Review findings | 13 untracked `REVIEW-pr*-herdr.md`, `REVIEW.md`, council reviews | scattered; drift between what's marked fixed and what is |
| Plans | `.cursor/plans/*.md` | only one tool reads them |
| Engine facts | nowhere | rediscovered every session |
| "Is X fixed on origin?" | nowhere | about 20 claims checked by hand during the audit |

User docs shouldn't hold debates, research or history that is stale but still useful. ^[raw/issues/issue-113.md]

## What the wiki gives you

1. **Knowledge builds up.** A new session reads `index.md` and a few pages instead of paying for another large research pass ([[llm-wiki-pattern]]).
2. **Contradictions surface.** Lint can catch drift, such as the webhook docs saying `0.0.0.0` when the code binds `127.0.0.1`.
3. **Decisions keep their reasons and revisit triggers.** The kanban's weekly triage can check those triggers ([[0005-kanban-and-single-issue-workflow]]).
4. **Every tool shares one memory.** It is plain markdown, so Claude Code, Cursor, Herdr, Hermes and Lich can all read it.
5. **It feeds the docs.** The "how agent harnesses work" doc drafted in #113 is essentially a polished set of concept pages.

## It is also a product experiment

Lich has no memory or skills subsystem. A **lore wiki** (shared world entities plus private per-NPC pages) and an **engine wiki** (progressive disclosure for agents that code games) have the same structure as this wiki. Dogfooding it here tests that format before it ships as a `MemoryStore` ([[npc-memory-namespaces]], #114 item 7). ^[raw/external/hermes-llm-wiki-skill.md]

## Guardrails

- Docs and code stay the source of truth for behaviour.
- Cite `path:line@sha`, and never copy kanban status into pages.
- Update on events, not continuously.
- Lint regularly.
- Don't ship the wiki in the npm package or the VitePress site.

Related: [[memory-vs-skills]], [[roadmap-issues]].
