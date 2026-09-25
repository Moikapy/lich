---
name: lich-kanban
description: Manage the Lich Roadmap kanban (GitHub Project Moikapy/projects/2) together with the maintainer — view the board, file issues, move cards between Backlog/Deferred/Todo/In Progress/In Review/Done, and keep card status in sync with issues, PRs and labels. Use when asked about the roadmap, board, kanban, project status, "what should we work on next", triage, or when starting/finishing work on a lich issue or PR.
---

# Lich Roadmap kanban

The board is **https://github.com/users/Moikapy/projects/2** ("Lich Roadmap").
It is linked to `Moikapy/lich`. Every open issue should be on it.

All operations go through `scripts/kanban.sh` (next to this file), which wraps
`gh project` and resolves IDs by name. The `gh` token needs the `project`
scope. If a command fails with a missing-scope error, ask the maintainer to run
`! gh auth refresh -s project`. Do not run it yourself (it's interactive).

```bash
K=.claude/skills/lich-kanban/scripts/kanban.sh
$K board                          # the whole board, grouped by column
$K audit                          # cards whose column disagrees with GitHub state
$K move 82 "In Progress"          # move a card (adds it if missing)
$K add 120 Todo                   # put an existing issue on the board
$K new Backlog "serve: add text_delta events" "enhancement,serve" body.md
```

## Columns (the Status field)

| Column | Meaning | Enter when… | Leave when… |
|---|---|---|---|
| **Backlog** | Wanted, not scheduled | Issue filed without a plan to start soon | The maintainer picks it for the current cycle, then Todo |
| **Deferred** | Deliberately parked | It has a written *revisit trigger* (see #114) and the `deferred` label | Its trigger is met, then Backlog or Todo; remove the `deferred` label |
| **Todo** | Scheduled, ready to start | Scope is clear enough to begin | Someone starts a branch or worktree, then In Progress |
| **In Progress** | Actively being worked | A branch or worktree exists for it | A PR is opened, then In Review |
| **In Review** | PR open | PR references the issue (`Closes #N`) | PR merged, then Done; PR needs rework, then In Progress |
| **Done** | Merged or closed | Issue closed | Never, unless the issue is reopened |

**Work-in-progress limit:** keep **In Progress ≤ 3** cards per person or agent.
If you're about to exceed it, finish or park something first, or ask.

## Rules for agents

1. **The maintainer decides priority.** You may move cards along the natural
   flow (Todo → In Progress → In Review → Done) when the underlying fact is
   true (a branch exists, a PR opened, a PR merged). Ask before:
   - moving anything *into* Todo or Deferred
   - moving anything *out of* Deferred
   - moving a card backwards
   - closing an issue
2. **Never delete cards, issues or labels.** Archive or close only with explicit approval.
3. **One issue per unit of work.** When the maintainer asks for a batch of
   changes to be captured, collect them into a single issue (with a checklist)
   rather than filing many. Split into child issues only when asked. Reference
   the parent (`Part of #113`).
4. **Deferred work carries its reason.** A Deferred card must have the
   `deferred` label and a "Revisit when:" line in its body, or be an item in
   #114. `audit` flags label/column mismatches.
5. **PRs close issues.** PR bodies say `Closes #N` so the merge moves the card
   to Done automatically.
6. **Say what you changed.** After any board edit, report the moves in one
   line each (`#82 In Review → In Progress (needs SessionManager first)`).

## Routines

**Start of a work session ("what's next?")**
1. `$K audit`: fix trivially true mismatches (closed → Done, open PR → In
   Review) and report the rest.
2. `$K board`: summarise In Progress and In Review first (unfinished work beats
   new work), then the top of Todo.
3. Propose 1–3 next items with a one-line reason each. The maintainer picks.

**Starting an issue:** create a branch or worktree (convention:
`.worktrees/issue-<N>-<slug>` on branch `issue-<N>-<slug>`; the
`.worktrees/` dir is gitignored at the repo root), then
`$K move <N> "In Progress"`.

```bash
mkdir -p .worktrees
git worktree add ".worktrees/issue-<N>-<slug>" -b "issue-<N>-<slug>"
```

**Opening a PR:** include `Closes #<N>` in the PR body, then `$K move <N> "In Review"`.

**Weekly triage (when asked)**
- Run `audit` and `board`.
- Check each Deferred item's revisit trigger against the current state of `main`,
  and list any whose trigger is now met.
- Flag Backlog items older than ~30 days with no activity; suggest closing or deferring.
- Flag In Progress cards with no commits in 7+ days.
- Present findings as a short list. Make no moves beyond rule 1 without approval.

## Labels

| Label | Use |
|---|---|
| `architecture` | Layering, module boundaries, cross-cutting design (#113, #114) |
| `deferred` | Parked with a revisit trigger; pairs with the Deferred column |
| `serve` / `ossuary` | The serve protocol and desktop tracks (#79 epic) |
| `bug`, `enhancement`, `documentation` | GitHub defaults; one of these on every issue |

## Key issues

- **#113**: architecture and gap audit plus addenda (the gateway as hub, serve PR decision, modularity and DRY). This is the current plan of record.
- **#114**: deferred work, each item with a revisit trigger.
- **#79**: Ossuary epic (serve #81–#84, desktop #86–#94).
- **#46 / #47**: closed v0.7.0 REVIEW track; leftover test depth is #114 item 10.

## Limits of the API

`gh` cannot change a view's layout (Board vs Table) or edit project workflows
(auto-add, auto-close). Those are done by hand in the web UI. If they seem
off, tell the maintainer rather than working around them.
