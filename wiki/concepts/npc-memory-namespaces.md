---
title: NPC memory namespaces (private + shared world)
created: 2026-09-23
updated: 2026-09-23
type: concept
tags: [memory, npc, games]
sources: [raw/audits/2026-09-23-game-surface-audit.md, "#113", "#114"]
confidence: medium
---

# NPC memory namespaces

**Problem:** `ToolContext` is `{work_dir, env, signal}`, so a tool can't tell which NPC or player it is serving. In [[game-bridge-example]], every NPC shares one `memory.jsonl`, and reads return at most the last 20 notes. History is also lost on restart. ^[raw/audits/2026-09-23-game-surface-audit.md]

**Proposal** (#113 §4(C), #114 item 7):
- Put identity in context: `ToolContext` and `HookContext` gain `session_id`, `label` and `profile`.
- A `MemoryStore` with namespaces:

| Namespace | Scope |
|---|---|
| `npc:<id>` | private to one NPC |
| `world` | shared lore and facts |
| `user` | about the player |

- Retrieval: recency plus keywords first, embeddings later (deferred).
- Persistence: stored alongside [[lich-sessions]].

**Format:** the wiki pattern itself can serve as the memory format ([[llm-wiki-pattern]]):
- `world` as entity pages for factions, places and characters
- a per-NPC page for each character
- an index loaded into the prompt, with pages read on demand

This project's wiki is the prototype for that format ([[0006-in-repo-llm-wiki]]).

Related: [[memory-vs-skills]], [[runtime-profile-session]].
