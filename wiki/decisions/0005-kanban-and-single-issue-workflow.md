---
title: "0005: Kanban (Lich Roadmap) and single-issue capture workflow"
created: 2026-09-23
updated: 2026-09-23
type: decision
tags: [decision, process, roadmap]
sources: [raw/issues/issue-113.md, raw/issues/issue-114.md]
status: accepted
issue: "#113"
revisit_when: "More than one human contributor is active, or the board regularly drifts from GitHub state (audit findings every week)"
---

# 0005: Kanban and single-issue workflow

## Context

Work was scattered across about 40 worktrees, untracked REVIEW files and issue threads, with nowhere to see status in one place. The owner asked for two things:
1. That **any changes be captured as a single GitHub issue**, not filed piecemeal.
2. A kanban for managing the project together with agents.

## Decision

- **Capture:** a batch of requested changes goes into **one issue with a checklist** (#113 is the plan of record). Addenda go in as comments on it. Items split out into child issues only when the owner asks. Deferred work goes to #114 with a revisit trigger.
- **Board:** the GitHub Project **Lich Roadmap** (#2, https://github.com/users/Moikapy/projects/2), linked to `Moikapy/lich`.
  - Status columns: **Backlog · Deferred · Todo · In Progress · In Review · Done**.
- **Labels:**
  - `deferred`: pairs with the Deferred column
  - `architecture`: layering and cross-cutting design
- **Tooling:** the project skill `.claude/skills/lich-kanban/`, whose `kanban.sh` has `board`, `audit`, `move`, `add` and `new`.
- **Agent rules:**
  - Agents advance cards **only on facts**: a branch or worktree exists → In Progress; a PR with `Closes #N` → In Review; a merge → Done.
  - Any priority change needs approval: moving into Todo or Deferred, moving out of Deferred, moving backwards, or closing issues.
  - Never delete cards, issues or labels.
  - At most 3 cards In Progress.
- The skill is **project-level**, not user-level, because it is hard-wired to this repo and should be shared with every worktree and collaborator ([[project-vs-user-skill]]).

## Consequences

- One place shows status; the wiki holds the reasons ([[0006-in-repo-llm-wiki]]). The wiki never copies card status.
- `kanban.sh audit` catches drift: closed issues not in Done, open PRs not in In Review, label/column mismatches.
- The GitHub API can't set the board layout or project workflows, so those are done by hand in the web UI.

## Alternatives considered

- **One issue per finding.** Rejected by the owner: it's noisy, and it fragments the plan.
- **A kanban kept in the repo** (markdown or Hermes kanban). Rejected: GitHub Projects links issues and PRs natively.

## Revisit when

More than one human contributor is active, or the weekly audit keeps finding drift. Either one suggests automating the moves (for example, workflows in GitHub Actions).

Related: [[roadmap-issues]], [[0001-gateway-as-hub]].
