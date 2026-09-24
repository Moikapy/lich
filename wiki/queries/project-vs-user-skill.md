---
title: "Query: should the kanban skill be project-level or user-level?"
created: 2026-09-23
updated: 2026-09-23
type: query
tags: [process, roadmap]
sources: ["#113"]
confidence: high
---

# Should the kanban skill be project-level or user-level?

*Asked by the maintainer on 2026-09-23, about the `lich-kanban` skill described in [[0005-kanban-and-single-issue-workflow]].*

## Answer: project-level

The skill lives at `.claude/skills/lich-kanban/` inside the lich repository.

**Reasons:**
1. **It only works for this repository.** `scripts/kanban.sh` hard-codes `Moikapy/lich` and GitHub Project #2. At user level (`~/.claude/skills/`) it would load in every session, including unrelated Blender and ComfyUI work, and only add noise.
2. **It is meant for collaboration.** Committed to the repository, it reaches every worktree (`~/code/lich-wt-issue-*`), every clone and every collaborator. A user-level skill exists only on one machine.
3. **The rules evolve with the repository.** Column definitions, key issues ([[roadmap-issues]]) and label conventions are versioned alongside the code they describe, and changes go through PRs.
4. **Other agents depend on the path inside the repository.** The AGENTS.md text points Cursor, Herdr, Hermes and Lich at `.claude/skills/lich-kanban/scripts/kanban.sh`.

**Caveat:** until the skill is committed and merged, separate worktree checkouts don't see it.

## If you want it everywhere anyway

Use a symlink rather than a copy:

```bash
ln -s ~/code/lich/.claude/skills/lich-kanban ~/.claude/skills/lich-kanban
```

The symlink only works while the main checkout stays where it is.

## When a user-level skill *would* be right

A **generic** "manage any GitHub Projects board" skill that takes the owner and project number as arguments could be user-level. This Lich-specific skill would then stay as a thin project layer on top of it. The same reasoning applies to the `lich-wiki` skill ([[0006-in-repo-llm-wiki]]).

Related: [[llm-wiki-vs-docs]].
