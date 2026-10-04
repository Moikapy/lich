# Lich Wiki Schema

## Domain

This wiki is the working knowledge base for **Lich**, the TypeScript Think-Act-Observe agent harness. It covers:

- how Lich works internally, and why it is shaped that way
- architectural decisions and their revisit triggers
- research on comparable agents (Hermes, and others)
- knowledge for Lich's **idea-agnostic** harness (#113 Addendum 5 / [[0008-idea-agnostic-extensible-harness]]), including dogfood verticals:
  - **code / play / live-in games**
  - **create content** (video, Shorts, clipping, art — Addendum 4 / [[0007-content-as-fourth-goal]])
  - and any other vertical users build via plugins and tools

### How it relates to the other sources of truth

| Artifact | Answers | Source of truth for |
|---|---|---|
| `docs/` (VitePress, shipped) | What Lich does, and how to use it | User-facing behaviour |
| Code + tests | What Lich actually does | Behaviour. It always wins. |
| Kanban (GitHub Project #2) and issues | What to do next, and who is doing it | Status and priority |
| **This wiki** | What we know, and why | Rationale, research, synthesis, history |

Never copy card status or issue checklists into the wiki. Link to the issue (`#113`) instead. When the wiki and the code disagree, the code is right: fix the wiki and log it.

## Layers

- `raw/` is immutable source material. Agents read these files and never edit them. Re-ingesting a changed source creates a new file with a date prefix.
  - `raw/audits/`: audit and research reports
  - `raw/issues/`: snapshots of GitHub issues, including comments
  - `raw/reviews/`: code-review write-ups (Herdr, the REVIEW.md series)
  - `raw/external/`: outside references (papers, other projects' docs, engine docs)
- Agent-maintained pages:
  - `entities/`: concrete things (Lich modules, other agents, engines, key issues)
  - `concepts/`: ideas and patterns (action-terminal mode, prompt-cache tiers…)
  - `comparisons/`: side-by-side analyses
  - `decisions/`: one page per architectural decision, numbered `NNNN-slug.md`
  - `queries/`: answers to questions that are worth keeping
- `_archive/`: superseded pages. Move them here rather than deleting, and remove them from the index.
- `index.md` is the catalog: every page with a one-line summary.
- `log.md` is append-only: one entry per action.
- `scripts/lint.mjs` is the structural linter (`node wiki/scripts/lint.mjs`).

## Conventions

- File names are lowercase and hyphenated. Slugs are unique across the whole wiki, so `[[slug]]` resolves without a folder.
- Every page outside `raw/` starts with frontmatter (below) and links to **at least 2** other pages with `[[slug]]`.
- **Cite code as `path:line@sha`**, for example `src/agent/loop.ts:110@77bc148`. A citation without a SHA goes stale silently. Issues are cited as `#N`, raw sources as `^[raw/audits/file.md]`.
- On pages that synthesize 3 or more sources, add `^[raw/...]` provenance at the end of each paragraph that relies on a specific source.
- When you update a page, bump `updated:`. Every new page is added to `index.md`, and every action is appended to `log.md`.
- Mark claims about a specific version with that version, e.g. "(v0.9.0) fixed on origin".

## Frontmatter

```yaml
---
title: Page Title
created: YYYY-MM-DD
updated: YYYY-MM-DD
type: entity | concept | comparison | decision | query
tags: [from taxonomy]
sources: [raw/audits/…md, "#113"]
confidence: high | medium | low      # optional
contested: true                      # optional; unresolved contradiction
---
```

Decision pages add these fields:

```yaml
status: proposed | accepted | superseded | rejected
issue: "#113"
revisit_when: "one-line trigger"
superseded_by: NNNN-slug            # when status is superseded
```

Raw files carry `source_url`, `ingested` and `sha256`. The hash covers the body only, not the frontmatter.

## Tag taxonomy

Add a tag here before you use it.

- **Layers:** core, runtime, surface, gateway, serve, ossuary, cli, tui
- **Subsystems:** providers, tools, plugins, mcp, sessions, events, context, memory, skills, security
- **Games:** games, npc, play, editor, engines, content
- **Comparisons:** hermes, ecosystem
- **Meta:** decision, roadmap, process, docs, performance, research

## Page thresholds

- **Create a page** when a thing appears in 2 or more sources, or is central to a decision.
- **Split a page** when it passes about 150 lines.
- **Do not create a page** for passing mentions, or for anything the user docs already cover well. Link to the doc instead.

## Operations

- **Orient** at the start of each session: read this file, `index.md`, and the last ~30 entries of `log.md`.
- **Ingest:**
  1. Put the source in `raw/`, with its hash.
  2. Update or create the affected pages.
  3. Update `index.md`.
  4. Log the change.
- **Query:** answer from the wiki first, citing pages. File the answer in `queries/` if it is worth keeping.
- **Lint:** run `node wiki/scripts/lint.mjs`. That covers frontmatter, the index and links. Then check by judgment:
  - stale `@sha` citations
  - decisions whose `revisit_when` has fired
  - pages marked `contested` or `confidence: low`
  - contradictions with the code or docs

  Log the findings.

## When to update (events, not continuously)

- A PR merges that changes something a page describes.
- A review or audit finishes (its report goes into `raw/`).
- A decision is made or reversed (a new or updated `decisions/` page).
- Research on an outside system is completed.
- A useful question is answered (a new `queries/` page).
