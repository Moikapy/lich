---
title: Memory vs skills (declarative vs procedural, progressive disclosure)
created: 2026-09-23
updated: 2026-09-23
type: concept
tags: [memory, skills, hermes, research]
sources: [raw/audits/2026-09-23-hermes-vs-lich.md, raw/audits/2026-09-23-core-engine-audit.md]
confidence: high
---

# Memory vs skills

Hermes separates two kinds of long-term knowledge: ^[raw/audits/2026-09-23-hermes-vs-lich.md]

| | Memory (declarative) | Skills (procedural) |
|---|---|---|
| **What** | Short facts about the user, the environment and the world | How-to documents for recurring tasks |
| **Size** | Bounded (MEMORY 2200 chars, USER 1375) | Unbounded; each one is a directory |
| **In the prompt** | The whole snapshot, frozen at session start | **Only an index** (name + description) |
| **Loaded** | Always | On demand with `skill_view`: *progressive disclosure* |
| **Written by** | the `memory` tool | `skill_manage`; background review; the curator archives stale ones |

**Progressive disclosure** keeps the prompt small while the agent's knowledge grows. This wiki uses the same principle: agents read `index.md` first and open pages only as they need them ([[llm-wiki-pattern]]).

**Lich today:** no memory or skills subsystem in code. ^[raw/audits/2026-09-23-core-engine-audit.md]
- `MEMORY.md` is only a README convention: append-only and never auto-loaded.
- Skills are `.lich/skills/*.md` files that the agent writes with `write_file` and finds only through `docs_search`, as "reference data, not instructions".
- Lich's "self-improvement loop" is the gatekeeper's single gated `git_commit` ([[lich-plugins-and-hooks]]). It does not learn anything.

**For games:**
- Memory needs **namespaces**: private per NPC, plus shared world memory; see [[npc-memory-namespaces]].
- Skills map onto **engine knowledge packs** (Godot signals, the Unity lifecycle) for agents that code games.

Related: [[prompt-cache-tiers]], [[hermes-agent]].
