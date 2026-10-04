# Agent guidelines for Lich

> Shared instructions for every coding agent working in this repo (Claude Code, Cursor, Herdr, Hermes, Lich).
> Read the whole file. Do not edit it without the maintainer's approval.

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## Project management (Lich Roadmap kanban)

Work is tracked on the GitHub Project **Lich Roadmap**: https://github.com/users/Moikapy/projects/2

Use the `lich-kanban` skill (`.claude/skills/lich-kanban/`) for all board operations. Other agents can call the helper directly (it needs `gh` with the `project` scope, plus `jq`):
`.claude/skills/lich-kanban/scripts/kanban.sh board | audit | move <N> "<Status>" | add <N> [Status] | new <Status> "<title>" [labels] [body-file]`

- **Start of a session:** run `kanban.sh audit`, then `board`, and propose next items. Don't pick priorities yourself.
- **Move cards forward only when it's factually true:**
  - branch or worktree exists (`.worktrees/issue-<N>-<slug>` under the repo root) → In Progress
  - PR opened, with `Closes #N` in the body → In Review
  - merging moves it to Done
- **Ask before** moving into Todo or Deferred, moving out of Deferred, moving backwards, or closing issues. Never delete cards, issues, or labels.
- **Keep In Progress ≤ 3 cards.**
- **When asked to capture a batch of changes,** file **one** issue with a checklist, not many. Deferred work goes to #114 (or gets the `deferred` label plus a "Revisit when:" line).
- **Plan of record:** #113 (architecture audit plus addenda). Deferred: #114. Ossuary/serve epic: #79.
- **After any board edit,** report each move in one line: `#N From → To (reason)`.

## Project knowledge (wiki/)

`wiki/` is the LLM-maintained knowledge base: research, rationale, decisions, game and engine knowledge. The docs (`docs/`) say what Lich does, the kanban says what's next, and the code is the truth. Procedures are in the `lich-wiki` skill (`.claude/skills/lich-wiki/SKILL.md`).

- **Before architecture or design work:** read `wiki/SCHEMA.md`, `wiki/index.md`, and the last ~30 lines of `wiki/log.md`.
- **Code and tests beat the wiki.** If they disagree, fix the wiki and log it.
- **Update on events:** PR merged, review or audit done, research done, decision made. Add one `log.md` line per action.
- **Rules for edits:**
  - Never edit `wiki/raw/`.
  - Cite code as `path:line@sha`.
  - Never copy kanban status into the wiki.
  - Decisions go in `wiki/decisions/` (ADR format, with `revisit_when`).
- **Run `node wiki/scripts/lint.mjs` after edits.**
