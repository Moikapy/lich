---
source_url: file://lich/REVIEW-pr72-herdr.md (untracked, copied 2026-09-23)
ingested: 2026-09-23
sha256: 250f3402a9e2a12df2f90be873b7802b617a3542377c9f882c93fe95939f4c43
---
# Review: PR #72 — fix(agent): REVIEW should-fix A-7/A-8/A-10–A-13 (#37)

Repo: Moikapy/lich · Branch: `feat/review-agent-37` → `main` · Reviewed at PR head. main is 8 commits ahead (PRs #73, #76); none touch the files in this PR and `git merge-tree` reports no conflicts.

## VERDICT: FAIL

### Verification performed

- Full vitest suite on the PR head: 400 passed, 2 failed. Both failures are environment-only (review worktree under `/tmp`; unbuilt `dist/`). Neither touches PR code.
- `tsc --noEmit`: clean.
- Sound and not flagged: duplicate-provider-name rejection, `compress_end.usage` folded into `usage_total` and the TUI usage counter, the recorder ignoring summarizer usage (no phantom assistant line), `turn_end` now emitted on the final path (loop.ts:288), after each tool turn, and after `budget_exhausted` on the last turn, head+tail truncation arithmetic (`2*half + marker <= max_chars`), the previously unused `hint` now actually appended to the summary request, `wx`-exclusive creation with pid + random entropy, and the new `index.ts` exports.

---

### Findings (most severe first)

#### 1. `src/agent/loop.ts:203` and `src/agent/loop.ts:233` — compression is disabled for the rest of the run after a transient condition

**Why:** Both branches set `skip_until_turn = Number.POSITIVE_INFINITY`.

- Line 203: when non-system history is at most `KEEP_RECENT_TURNS` (8) messages but already over threshold (e.g. a resumed short history with one huge tool result, or a big early tool output). History keeps growing every turn, so a few turns later there is plenty to summarize, but compression never runs again.
- Line 233: when the kept-recent tail alone is over budget. The tail is a sliding window of the last 8 non-system messages; the oversized message ages out within 8 turns. The comment on the sibling branch at line 237 even says "retry after backoff so huge turns can age out", which is exactly the case here too.

In both cases every subsequent provider call is sent uncompressed and will overflow once the window fills, turning a recoverable situation into a failed run. Before this PR the loop re-evaluated every turn.

**Fix hint:** Replace both `POSITIVE_INFINITY` assignments with `schedule_compress_backoff(backoff, turn)`. The existing test `backs off when compression cannot get under the threshold` (test/loop.test.ts:332, `max_turns: 4`, asserts one summarizer call) still passes with a 3-turn backoff. Add a test with `max_turns: 12` where a huge early tool result ages out of the kept window and assert a second summarizer call happens after the backoff.

#### 2. `src/session/store.ts:54` — `wx` creates the transcript eagerly, so every TUI launch leaves an empty `.jsonl` that becomes `latest`

**Why:** `create_unique_session_path` opens and closes the file to reserve the name. Previously the file appeared on first append. `run_tui` (src/tui.tsx:23) opens the per-launch session before the first message, so launching the TUI and quitting now writes a zero-byte transcript with the newest mtime. `resolve_session_path` sorts by mtime and has no size filter (src/session/resolve.ts:37 only checks `isFile`), so `lich --resume latest` and `/resume latest` resolve to the empty file and show "resumed … (0 messages)". `/sessions` (src/tui/app.tsx:105) lists it too. This regresses the resume feature shipped in PRs #65/#66.

**Fix hint:** Either keep creation lazy (reserve the id in memory; the pid + random entropy already makes collisions negligible, and `appendFile` on first write with the `wx`-checked name is enough), or skip zero-size files in `resolve_session_path` and the `/sessions` listing. Add a test: `open_session` then `resolve_session_path(dir, "latest")` should not return a file with no records.

#### 3. `src/agent/config.ts:140` — "deep-freeze" only freezes the `plugins` array

**Why:** The PR summary claims deep-freeze, but `Object.freeze(config.plugins)` leaves each plugin entry object mutable. Low severity; the intent is documented behaviour so either freeze entries or reword the summary/changelog.

**Fix hint:** `for (const plugin of config.plugins) Object.freeze(plugin);` alongside the array freeze, mirroring the provider loop above it.

#### 4. Docs left stale by this PR

- `docs/user-guide/cli.md:172` and `docs/architecture/agent-loop.md:177` still document the filename as `<timestamp36>-<counter>[-label].jsonl`; it is now `<timestamp36>-<pid36>-<rand6>-<counter>[-label].jsonl`. The `--resume <id>` examples (`m1abc-1-tui`) no longer match real ids.
- `docs/user-guide/library.md:194` says `read_session_messages` "is not a package export"; A-13 exports it (and `open_session`) from `index.ts`.
- CHANGELOG has no entry for the id format change, the new exports, or compression usage accounting.

---

### Missing tests

- Finite-backoff recovery (finding 1): huge early message ages out, compression retried.
- Empty transcript vs `latest` (finding 2).
- `compress_end.usage` reaching `AgentRunResult.usage_total` at the Agent level: only the loop-level and recorder-level behaviour is tested; `collect_usage` in agent.ts is untested for the new branch.
- `turn_end` on the final path: the loop tests added cover backoff and the length of the transcript, but nothing asserts the emitted `turn_end` sequence for final vs budget vs aborted outcomes.

---

### Notes (no action required)

- `transcript_char_budget` caps at 96k chars (~24k tokens) for large budgets; sensible since the summarizer request goes to the same provider.
- `format_capped_transcript` applies a 256-char floor per message, then re-truncates the joined text; fine.
- `split_keep_recent` is now exported for the loop's `kept_tail_over_budget`; the orphan-tool-result guard is preserved.
