---
source_url: file://lich/REVIEW-pr71-herdr.md (untracked, copied 2026-09-23)
ingested: 2026-09-23
sha256: f3fd02858d39fd5da5142c0021991fb9de5e37852c47b7fb0a8d478e13aa9a92
---
# Review: PR #71 — test: T-3/T-4 coverage for review issue #46

Repo: Moikapy/lich · Branch: `feat/review-tests-46` → `main` · Tests-only PR. Reviewed at PR head, which is based on the current origin/main tip (no divergence, no conflicts).

## VERDICT: FAIL

### Verification performed

- Full vitest suite on the PR head: 4 failures. Two are environment-only (review worktree under `/tmp`; unbuilt `dist/`). **Two are tests this PR adds or changes, failing against the PR's own base.**
- `tsc --noEmit`: clean.
- Built `dist/` in the worktree (tsup) and re-ran test/game_bridge.test.ts: 11 passed, and `<repo>/.lich/game` was not created. The T-3 change works as described.
- Sound and not flagged: `agent_chained_run` (single system message, 9 messages after three runs), `agent_abort_run` (abort mid-chat → `aborted`, no assistant; abort on first `tool_call_start` → second call recorded as a cancelled error tool message in memory), `compression_pairing` (orphan-tool invariant with `keep_recent` cutting inside a tool group), `gateway_conversation_bounds` (oldest key evicted at cap, re-entry starts empty, retained key keeps history).

---

### Findings (most severe first)

#### 1. `test/loop.test.ts:77` and `:92` — scenario A now asserts behaviour main no longer has

**Why:** The rewritten assertion slices the first 8 events and then requires exactly one `turn_end`. The PR description says mid-tool turns "do not emit turn_end today (A-10 still open on main until #72 merges)", but #72 is already in main: `src/agent/loop.ts` emits `turn_end` at lines 288, 296, and 300 (final path, every tool turn, budget path). On the PR head the test fails with "expected [ 'turn_start', 'llm_start', …(6) ] to deeply equal [ …(7) ]" because the tool turn now emits `turn_end` before the second `turn_start`.

**Fix hint:** Restore the full balanced sequence: `turn_start, llm_start, llm_end, tool_call_start, tool_call_end, turn_end, turn_start, llm_start, llm_end, final, turn_end`, and assert `turn_end` count equals `turn_start` count (2). Drop the slice.

#### 2. `test/provider_finish_reason.test.ts:44` (assert at `:72`) — "keeps tool_calls when finish_reason is length" encodes pre-#73 behaviour

**Why:** #73 (merged) omits executable tool calls when `finish_reason` is `length` and appends `[truncated tool call omitted]` to the content (`src/providers/openai.ts:372`). The test expects `tool_calls` to have length 1 with `args: {}`; on the PR head `tool_calls` is `undefined` and the assertion throws "Target cannot be null or undefined". The PR summary states "no dependency on unmerged other PRs", but the dependency here is on a PR that *has* merged and changed the contract.

**Fix hint:** Rename to "omits tool calls when finish_reason is length" and assert `result.message.tool_calls` is `undefined` and `result.message.content` contains `[truncated tool call omitted]`. Keep the `finish_reason === "length"` assertion.

#### 3. `test/agent_abort_run.test.ts:118` — the cancelled tool message is asserted in memory only

**Why:** The point of the abort coverage is that a resumable transcript stays well-formed. The test checks `result.messages` but not the JSONL written to `session_dir`. That is exactly where the recorder path can diverge (a cancelled call gets no `tool_call_end` event). Low severity for a test PR, but it is the highest-value assertion missing from this file.

**Fix hint:** After the run, `read_session_messages(result.session_path)` and assert the same two tool ids appear on disk.

---

### Missing coverage noted by the PR itself

The description's leftovers list is accurate. Nothing further to add beyond finding 3.

---

### Notes (no action required)

- `agent_chained_run` relies on the mock returning the last body for any extra call; fine for the three-run script.
- `gateway_conversation_bounds` uses `history_cap: 40` and `max_conversations: 2`; the eviction assertion (`a2` starts with empty history) is correct for the current bus.
