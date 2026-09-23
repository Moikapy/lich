---
source_url: file://lich/REVIEW-pr66-herdr.md (untracked, copied 2026-09-23)
ingested: 2026-09-23
sha256: 02163c11bc10c2753a4489913000f97d300c7b63e6228af4f57c31567059ac72
---
# Herdr → Claude review: PR #66 (Phase 3 /resume slash command)

**Source:** Herdr Claude agent pane `w6590b22082fb22:p2`  
**Date:** 2026-09-22  
**PR head verified:** `51be0eb` (up to date with origin/main)

## VERDICT: PASS

No correctness bugs or regressions found. The suite passes except the same two environment-only failures seen on the earlier reviews, and `tsc --noEmit` is clean. The slash parser trims args, so `/resume  latest` resolves correctly. The command bar drops all input while a run is active, so `/resume` cannot land mid-run and be overwritten by `finish_run`. The banner state, history setter, and block reset are wired sensibly.

## Findings

### 1. `src/tui/app.tsx:212` — message during `/resume` load can silently discard resumed history

The load is async and the UI stays idle during it. If the user submits a message before the two file reads finish, the run starts with the old history, then the resume result replaces the on-screen blocks and `history_ref`, and `finish_run` overwrites `history_ref` again with the old-history result. The screen then shows the resumed transcript while the agent continues the old conversation. Small window, but the failure is silent and confusing.

**Fix hint:** set a busy phase (or a local loading flag passed to `CommandBar`) before calling `load_resume_view` and clear it in the promise's settle, or drop the resume result when a run started in the meantime.

### 2. `src/tui/app.tsx:116` — `load_resume_view` is untested

Tests cover `parse_command`, `resume_session_view`, and the missing-args block, but nothing exercises the resolve-then-read path, the error-to-notice mapping for a missing or ambiguous id, or the id derived from the filename. It is a plain async function with no hook dependencies.

**Fix hint:** Export it and test it against a temp session dir: one case for `latest` returning blocks and a banner line, one for a missing id returning an error block whose text contains the resolver's candidates.

### 3. `src/tui/state.ts:193` — resume notice can push block list to cap + 1 (harmless)

`resume_session_view` prepends the notice to a list already trimmed to `HISTORY_CAP`. Harmless today because the next `add_blocks` re-slices, but pass `cap - 1` to `split_history_blocks` if the cap is meant to be exact.

## Merge-order note (not a defect)

A three-way merge of PR #66 and PR #67 conflicts in `CHANGELOG.md`, `docs/user-guide/cli.md`, and `src/tui/app.tsx`, so whichever lands second needs a rebase.

**Behavioral interaction after both merge:** PR #67 seeds history into the shared per-launch file only once per handle, so after both merge an in-TUI `/resume` swaps the in-memory history without writing it to the transcript, and the file no longer matches what the agent is continuing. The rebased PR should either reset the recorder's seeded flag or open a fresh handle on `/resume`.
