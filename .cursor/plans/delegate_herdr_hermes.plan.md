# Plan: Cursor workers + Herdr→Claude review + Hermes docs

Status: corrected draft (aligned to herdr v0.9.1 SKILL.md)  
Repo: `/home/moika/code/lich`  
Skill sources:
- Official: https://github.com/herdrdev/herdr/blob/v0.9.1/skills/herdr/SKILL.md  
  (raw: https://raw.githubusercontent.com/herdrdev/herdr/v0.9.1/skills/herdr/SKILL.md)
- Local authority: `herdr --skill` (same text as v0.9.1; herdr 0.9.1 on PATH)
- No separate cached copy under `~/.herdr` skills; korvax has related devops skills at `~/.korvax/skills/devops/herdr-*` (not the official herdr skill)

**Assumptions (user-confirmed):** Herdr is already in use; Claude is already running under Herdr; Hermes is already running. Do **not** treat `herdr integration install claude` as a blocker. Do **not** start/stop Herdr or reinstall agents unless the user asks.

---

## 1. Goal and non-goals

### Goal

Give the Cursor/Auto **parent coordinator** a clear routing loop:

1. **Cursor Task workers** implement, investigate, and test (preferably in git worktrees).
2. **Herdr → Claude** (already-running agent pane) runs a second-opinion / council-style **review** on a PR or diff after tests are green.
3. **Hermes** (via Herdr agent prompt when present, else `hermes` CLI) writes or updates **documentation only** after review fixes land (or when the user asks for docs).

### Non-goals

- Do **not** replace Cursor Task / Bugbot / Security Review workers entirely.
- Do **not** auto-merge, auto-publish, force-push, or auto-open releases.
- Do **not** make Hermes the primary implementer, or Claude the primary builder, unless the user explicitly asks.
- Do **not** put tokens, API keys, or auth material in rules/skills/plans.
- Do **not** require every trivial fix to pay for a full Herdr→Claude review.
- Do **not** install integrations, start/stop the Herdr server, or kill panes as part of this routing loop.

---

## 2. Role split

| Role | Tool | Owns | Does not own |
|------|------|------|--------------|
| Parent coordinator | Cursor Auto (this chat) | Routing, worktree hygiene, accepting verdicts, opening PRs when asked | Silent long-running agent farms; driving Herdr when `HERDR_ENV≠1` |
| Implement / investigate / test | Cursor `Task` workers (+ shells in worktrees) | Code, tests, local repro, CI diagnosis | Final external review; primary user-facing docs drafts |
| Review (diff/PR/council) | **Existing Herdr Claude agent** (`herdr agent prompt <name\|pane_id>`) | Actionable findings, PASS/FAIL-style verdict, optional council lenses | Primary feature implementation (unless user asks) |
| Documentation | **Existing Herdr Hermes agent**, or **`hermes` CLI** oneshot | Guides, changelog staging text, README/API doc updates as a docs branch | Broad refactors, secret-bearing config edits |
| Fast in-Cursor review (optional) | Cursor Bugbot / Security Review skills | Quick local-diff review without leaving Cursor | Substitute for Herdr→Claude when user asked for Claude review |

### What Herdr actually is (per SKILL.md)

Herdr is a **terminal multiplexer for coding agents**, not a “send this PR to Anthropic” API. Review/docs work by prompting agents that already occupy panes:

1. Confirm the controlling agent is inside Herdr (`HERDR_ENV=1`) — required by the official skill.
2. Discover live agents/panes with JSON list commands (do not guess IDs).
3. `herdr agent prompt <target> "..."` with `--wait` / `--timeout`.
4. Capture with `herdr agent read <target> --source recent-unwrapped`.

There is **no** first-class `herdr review <pr>` command. PR/diff context goes **in the prompt text** (Claude uses `gh` / `git` in its pane).

Supported agent kinds on this install include `claude` and `hermes` (among others). Agent targets are **unique live agent names** or **pane IDs hosting agents** — not terminal IDs or bare kind labels. Names match `[a-z][a-z0-9_-]{0,31}`.

### Hermes preference

1. **Preferred when Hermes is already a live Herdr agent:** `herdr agent prompt <hermes-name> "..."` (same surface as Claude).
2. **Fallback for Cursor coordinators outside Herdr:** `hermes -z` / `hermes chat -q --oneshot` with `--in <repo>` (does not require `HERDR_ENV=1`).

### Hard constraint: `HERDR_ENV=1`

Official skill gate:

```bash
test "${HERDR_ENV:-}" = 1
```

If the check fails, the skill says: report that you are **not** inside Herdr and **stop** — do not inspect or control the focused Herdr session from outside.

**Implication for Cursor Auto:** when this chat runs outside a Herdr pane (`HERDR_ENV` unset), the parent must **not** drive `herdr agent|pane|workspace` against the live session. Instead:

- Ask a Herdr-resident agent (or the user) to run the list/prompt/read recipe, **or**
- Use Cursor Task / Hermes CLI for work that does not need Herdr control.

Do **not** rely on another client's UI-focused pane. Prefer `--current`, an explicit pane ID, or a unique agent name (skill safety rules).

---

## 3. Trigger points (typical issue → PR loop)

```
issue/ask
  → Cursor Task: implement in worktree
  → Cursor Task / shell: tests green (and typecheck if applicable)
  → [optional] Cursor Bugbot/Security if user wants cheap pass
  → Herdr→Claude: review existing agent (diff or gh pr <N>)
  → Cursor Task: apply review fixes
  → re-test green
  → Hermes: docs-only update (Herdr prompt or hermes CLI)
  → human: approve merge / publish
```

| Moment | Call |
|--------|------|
| Spec unclear / multi-file design | Cursor Task (investigate) or ask user — **not** Hermes |
| Implementation | Cursor Task workers |
| Tests failing | Cursor Task / CI investigator — **not** Claude review yet |
| Impl + tests green, user wants Claude review | **Herdr → existing Claude agent** |
| Review FAIL with actionable code issues | Cursor Task fix loop |
| Review PASS (or user skips review) and docs lag | **Hermes docs** (Herdr agent or CLI) |
| Docs-only user ask | Hermes directly (skip Claude review) |
| Security-sensitive change | Prefer Cursor Security Review **and/or** Claude review; never Hermes as security reviewer |
| Coordinator outside Herdr | Do not drive Herdr CLI; hand the review/docs prompt to a Herdr-resident agent or the user |

---

## 4. Exact CLI (match SKILL.md)

Placeholders: `<CLAUDE_AGENT>`, `<HERMES_AGENT>`, `<PR>`, `<BRANCH>`.  
IDs look like `w1`, `w1:t1`, `w1:p1` — parse from JSON; never invent.  
**Never** put tokens in these commands.

### Gate (always first when intending to control Herdr)

```bash
test "${HERDR_ENV:-}" = 1
```

If that fails: stop Herdr control; use Cursor Task / Hermes CLI paths only.

### Discover (do not predict IDs)

```bash
herdr workspace list
herdr tab list --workspace "$HERDR_WORKSPACE_ID"
herdr pane current --current
herdr pane list --workspace "$HERDR_WORKSPACE_ID"
herdr agent list
```

Read live agent **names** and hosting **pane IDs** from the JSON. Claude and Hermes should already appear — use those targets. Only `agent start` if the user asks to create a new agent (requires an available shell pane; start never splits layout).

Optional layout only when the user wants a new sibling pane (not required if agents already exist):

```bash
herdr pane layout --pane "$HERDR_PANE_ID"
herdr pane split --current --direction right --cwd "$PWD" --no-focus
# → .result.pane.pane_id
```

### Prompt Claude for review (existing agent)

Skill-shaped prompt API:

```bash
herdr agent prompt <CLAUDE_AGENT> "Review the current diff and report only actionable findings." --wait --timeout 120000
```

PR-oriented brief (same surface; context in the prompt text):

```bash
herdr agent prompt <CLAUDE_AGENT> "$(cat <<'EOF'
Review GitHub PR #<PR> in this repo. Use gh if available.
Focus on correctness, regressions, and missing tests.
Output: VERDICT PASS|FAIL, then actionable findings only (file:line + why + fix hint).
Do not implement unless a finding is a one-line obvious fix and you state it.
EOF
)" --wait --timeout 120000
```

Diff / branch variant (no PR yet):

```bash
herdr agent prompt <CLAUDE_AGENT> "$(cat <<'EOF'
Review uncommitted/branch work vs origin/main.
Run: git fetch origin main && git diff origin/main...HEAD
Reply with VERDICT PASS|FAIL and actionable findings only.
EOF
)" --wait --timeout 120000
```

Council-style (reuse lich council docs as lenses):

```bash
herdr agent prompt <CLAUDE_AGENT> "$(cat <<'EOF'
Act as a single council reviewer for this PR.
Lens (named in kickoff): security | simplicity | architecture.
Match tone under docs/design/council/. VERDICT + findings only; no merge.
EOF
)" --wait --timeout 120000
```

### Capture review output

```bash
herdr agent get <CLAUDE_AGENT>
herdr agent read <CLAUDE_AGENT> --source recent-unwrapped --lines 120
```

If wait returns `blocked` or times out: inspect `get`/`read` before sending more input. Do **not** blindly re-prompt (`agent_prompt_stalled` / timeout does not prove the prompt was never delivered). Ask the user before answering approval/question UI.

Fallback if scrollback cannot recover the answer (skill): ask the agent to write Markdown under a temp directory and reply with only the file path, then read that file — **not** on the initial prompt.

### Hermes docs via Herdr (preferred when Hermes is a live agent)

```bash
herdr agent prompt <HERMES_AGENT> "$(cat <<'EOF'
Docs-only task for this repo.
Update user-facing docs to match the changed behavior below.
Do not change runtime source except docs/, changelog staging, or README.
Do not commit or push. Summarize files you would change.
Context: PR #<PR> or branch <BRANCH>; behavior bullets: ...
EOF
)" --wait --timeout 120000

herdr agent read <HERMES_AGENT> --source recent-unwrapped --lines 120
```

### Hermes docs via CLI (when outside Herdr or no Hermes pane)

```bash
hermes -z "$(cat <<'EOF'
Docs-only task for /home/moika/code/lich.
Update user-facing docs to match the merged/changed behavior described below.
Do not change runtime source except docs/, changelog staging, or README.
Do not commit or push. Summarize files you would change.
Context:
- PR #<PR> or branch <BRANCH>
- Bullet list of behavior changes: ...
EOF
)" --in /home/moika/code/lich --safe-mode
```

Quiet form:

```bash
hermes chat -q "Docs-only: sync guides for <FEATURE> to match main; list file edits; do not commit." \
  --oneshot -Q --in /home/moika/code/lich --safe-mode
```

### Ordinary pane commands (tests/servers — not agents)

Only when needed; skill pattern:

```bash
herdr pane run <pane_id> "just test"
herdr pane wait-output <pane_id> --match "test result" --timeout 120000
herdr pane read <pane_id> --source recent-unwrapped --lines 120
```

### Cursor side (coordinator)

- Spawn Task workers for impl/test as today.
- After Claude review text is captured, paste or write to `REVIEW.md` (or a dated `docs/design/council/` note) — human/coordinator decides whether findings become issues.
- Do not delete `REVIEW.md` from the main checkout as part of cleanup.

### CLI discovery note

Installed binary is authority: `herdr --help`, then group help via `herdr agent` / `herdr pane` / … (no bare `herdr` for discovery — that attaches the TUI). Do not probe mutating nested commands by omitting arguments.

---

## 5. Decision table (when the parent calls which)

| Situation | Cursor Task | Herdr→Claude | Hermes | Skip external |
|-----------|-------------|--------------|--------|---------------|
| New feature / non-trivial bugfix | Yes | After tests green | After review fixes if docs impacted | — |
| Typo / one-line docs edit | Maybe | No | Optional | Prefer Cursor alone |
| User says “Claude review this” | Prepare diff/PR | **Required** (existing agent) | No | — |
| User says “update the docs” | Only if code must change | No | **Required** | — |
| Tests red | Fix first | **Do not call** | No | — |
| Secrets / credentials in diff | Stop; redact | Do not paste secrets into prompts | Do not | — |
| Already reviewed by Claude this PR | Fix loop only | Re-review only if substantial new commits | Docs if needed | Avoid double-pay |
| User wants Bugbot only | Yes + Bugbot skill | No | No | OK |
| Coordinator has `HERDR_ENV≠1` | Yes | Hand off to Herdr-resident agent/user | Prefer `hermes` CLI | Do not drive Herdr from outside |
| Publish / release | Prepare notes | Optional release review | Changelog docs | Human merges |

---

## 6. Artifacts

| Artifact | Where | Who writes | Downstream |
|----------|-------|------------|------------|
| Implementation | Feature worktree under `/home/moika/code/lich-*` or Herdr worktree | Cursor Task | PR |
| Test evidence | CI / local test output in chat | Cursor Task | Gate before review |
| Review notes | Prefer `REVIEW.md` at repo root **or** `docs/design/council/<topic>-review.md` | Coordinator pastes Claude output (or Claude writes if instructed) | Human triage |
| Review → issues | Only if user asks, or coordinator proposes a short issue list for approval | Human / `gh issue create` after approval | Tracking |
| Docs changes | Branch `docs/*` or same feature PR | Hermes (proposed edits); Cursor applies/commits **when user asks** | Docs PR |

**Policy:** REVIEW.md-style findings do **not** auto-become issues. Coordinator summarizes; user confirms.

---

## 7. Risks and when NOT to call

| Risk | Mitigation |
|------|------------|
| Driving Herdr from Cursor outside a pane | Honor `HERDR_ENV=1` gate; hand off prompts |
| Focused-pane drift | Use agent name or explicit pane ID; never another client's focus |
| Double-review cost (Bugbot + Claude + Hermes) | One external reviewer per milestone; Hermes is docs-only |
| Secret leakage into agent panes/prompts | Never paste `.env` / tokens; `--safe-mode` on Hermes CLI; review public/committed diffs |
| Conflicting edits (Cursor + Claude + Hermes) | Serialize: impl → review → fix → docs; one writer per file set |
| Agent `blocked` on trust/approval UI | `agent get` / `read`; human answers; do not auto-approve |
| ID / name drift | Re-`list` every turn; names clear when agent exits/replaced |
| False “done” waits | Prefer `agent prompt --wait`; on timeout/stalled, `read` before re-prompt |
| Closing topology you did not create | Skill forbids unless user explicitly asked |
| Hermes invents APIs in docs | Require “match code on branch X”; human skim before commit |

**Do NOT call Herdr→Claude when:** tests fail; change is trivial; user only asked for docs; secrets present; a Claude review already exists for the same commit range; `HERDR_ENV≠1` and no handoff path.

**Do NOT call Hermes when:** task is implementation/debug; security review; merge/publish; or docs are already updated in the same PR by the implementer and user is satisfied.

**Do NOT:** `herdr server stop`, kill the main Herdr process, `workspace close --group` as a shortcut, or `herdr integration install claude` as a prerequisite for this loop.

---

## 8. First implementation slice (if user says Build)

### Primary approach (recommended)

Add a **repo-local Cursor rule** (or skill) at:

`/home/moika/code/lich/.cursor/rules/delegate-herdr-hermes.mdc`

(or `.cursor/skills/delegate-herdr-hermes/SKILL.md`)

that encodes:

1. Role split + decision table from this plan (short form).
2. Official skill gate (`HERDR_ENV=1`) + list → prompt → read recipe for **existing** Claude/Hermes agents.
3. Hermes CLI fallback when outside Herdr.
4. Explicit: Cursor Tasks remain default implementers; no auto-publish; no tokens; no integration install as a step.
5. Pointer to `herdr --skill` / v0.9.1 SKILL.md and this plan file.

Keep it lich-scoped so other repos are unaffected.

### Alternative

User-global / korvax `herdr-session-orchestrator` ceremony — only if the user wants that heavier multi-pane pipeline. Prefer the official herdr skill patterns above for lich.

### Build checklist (when asked)

1. Create the rule/skill from §8 primary (no commit until asked).
2. Dry-run from a Herdr pane: `herdr agent list` → prompt existing Claude on one small PR → `agent read` → capture into `REVIEW.md`.
3. Dry-run: Hermes docs (Herdr agent or CLI) against a known docs gap → show proposed file list, no commit.
4. Stop; report results to user.

---

## 9. Gaps / constraints (skill-aligned)

| Ask | Status |
|-----|--------|
| Herdr sends work to Claude for review | **Supported** via existing agent + `agent prompt` / `agent read` (not a dedicated review API) |
| Pass PR/diff | **Via prompt text** + `gh` / `git diff` in the Claude pane |
| Claude already running under Herdr | **Assumed** — list and prompt; do not require `agent start` or integration install |
| Hermes docs via Herdr | **Supported** (`--kind hermes` agents; prompt existing Hermes) |
| Hermes docs non-interactive outside Herdr | **Supported** (`hermes -z` / `chat -q --oneshot`) |
| Control Herdr from Cursor when `HERDR_ENV≠1` | **Forbidden by official skill** — hand off to Herdr-resident agent/user |
| Focused pane vs explicit IDs | Prefer agent name / explicit pane ID / `--current`; do not rely on another client's focus |
| Dedicated lich-docs skill | **Missing** — use explicit prompts (optional Hermes `--skills code-wiki` later) |
| Claude integration hooks | **Optional only** — not a blocker; do not install unless user asks |

Closest substitute if Herdr is unreachable from this chat: ask the user (or a Herdr-resident agent) to run the prompt/read recipe, or use Cursor Bugbot/Security Review — still do not auto-publish.
