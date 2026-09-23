---
source_url: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f (summary copied from ~/.kapy/wiki/sources/llm-wiki-karpathy.md)
ingested: 2026-09-23
sha256: 0f097e821c471549ee552203c8a4f8d3fdd17dd894989a7abff446aaed3ca3d7
---
---
tags: [knowledge-management, grimoire, architecture, rag, source]
---
# LLM Wiki (Karpathy)

**Source:** [Karpathy's Gist](https://gist.githubusercontent.com/karpathy/442a6bf555914893e9891c11519de94f/raw/ac46de1ad27f92b28ac95459c782c07f6b8c964a/llm-wiki.md)  
**Ingested:** 2026-04-19  
**Tags:** #knowledge-management #grimoire #architecture #rag

## Core Idea

Most LLM+documents setups use RAG: upload files, retrieve chunks at query time, re-derive answers from scratch. No accumulation. The LLM Wiki pattern is different — the LLM **incrementally builds and maintains a persistent wiki** between you and the raw sources. Knowledge is compiled once and kept current, not re-derived on every query.

**The wiki is a persistent, compounding artifact.** Cross-references exist. Contradictions are flagged. Synthesis reflects everything read. The wiki gets richer with every source and question.

## Three Layers

1. **Raw sources** — curated collection of source documents. Immutable. Read-only. Source of truth.
2. **The wiki** — LLM-generated markdown files. Summaries, entity pages, concept pages, comparisons, overview, synthesis. LLM owns this layer. You read it; LLM writes it.
3. **The schema** — document (CLAUDE.md, SOUL.md, etc.) telling the LLM wiki structure, conventions, workflows. Key config file. Co-evolved over time.

## Three Operations

### Ingest
Drop a source into raw collection, tell LLM to process. Flow: LLM reads source → discusses takeaways → writes summary page → updates index → updates relevant entity/concept pages → appends to log. One source may touch 10-15 wiki pages.

### Query
Ask questions against the wiki. LLM searches relevant pages, reads them, synthesizes answer with citations. **Critical insight: good answers get filed back into the wiki as new pages.** Comparisons, analyses, discovered connections — these compound in the knowledge base, not just evaporate into chat history.

### Lint
Periodic health-check. Look for: contradictions, stale claims, orphan pages, missing cross-references, concepts mentioned but lacking pages, data gaps fillable by web search.

## Indexing and Logging

- **index.md** — content-oriented catalog. Every page listed with link + one-line summary + metadata. Organized by category. LLM updates on every ingest. LLM reads index first for queries, then drills in. Works at moderate scale (~100 sources, ~hundreds of pages) without embedding-based RAG.
- **log.md** — chronological, append-only. Consistent prefixes make it parseable with unix tools. Gives timeline of wiki evolution.

## Optional: CLI Tools

At scale, the index file isn't enough. [qmd](https://github.com/tobi/qmd) — local search engine for markdown with hybrid BM25/vector search and LLM re-ranking. Has CLI (shell out) and MCP server (native tool).

## Tips

- Obsidian Web Clipper for browser → markdown
- Download images locally for LLM reference
- Obsidian graph view for wiki shape
- Marp for slide decks from wiki content
- Dataview plugin for frontmatter queries
- Wiki = git repo of markdown → version history, branching, collaboration for free

## Why This Works

The tedious part of knowledge management is the summarizing, cross-referencing, filing, and bookkeeping. LLMs are good at exactly this. Humans are good at sourcing, exploring, asking questions. The pattern plays to both strengths.

## Relevance to Kapy/Grimoire

This is the philosophical foundation of the grimoire system. Current gaps:
- Not filing good answers back as wiki pages (major compounding failure)
- Session-based, not always-on (grimoire is lifeline, not backup)
- No Obsidian integration for browsing
- No proper search tool at scale (qmd or similar)
- Log format needs consistent prefixes for parseability
