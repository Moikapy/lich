---
source_url: file://lich/REVIEW-pr67-herdr.md (untracked, copied 2026-09-23)
ingested: 2026-09-23
sha256: dd66ee4f0b19421842e1034b534d687d39eb0dea6f1eb62ea87e59ac0a424729
---
# Herdr → Claude review: PR #67 (Phase 2 incremental session persistence)

**Source:** Herdr Claude agent pane `w6590b22082fb22:p2`  
**Date:** 2026-09-22  
**PR head verified:** `32944a7` (up to date with origin/main)

## VERDICT: FAIL

One confirmed persistence regression. The suite passes except the same two environment-only failures seen on PR 65 (scratch dir under /tmp, no built dist), and `tsc --noEmit` is clean. Event ordering, the shared-handle seeding, `run_end` placement, and the compression path are sound. The compressor's summary calls emit no `llm_end`, so no phantom assistant messages land in the file.

## Findings (most severe first)

### 1. `src/agent/loop.ts:111` — cancelled tool messages are never persisted (must-fix)

When the signal is aborted mid tool calls, the loop pushes `cancelled_tool_message` into history but emits no `tool_call_end`, so the recorder never sees it. The old bulk write of `outcome.messages` included these.

**Reproduced:** mock provider returning two tool calls and aborting on the first `tool_call_start`: in-memory history has tool ids `c1` and `c2`, the file has only `c1`, so the assistant `tool_calls` record on disk references an id with no tool result. Resuming that transcript sends an unmatched tool call to the provider, which OpenAI and Anthropic both reject.

**Fix hint:** `cancelled_tool_message(call)` is byte-identical to `tool_message_from_result(call, {ok:false, output:"", error:"cancelled"})`, so build that result once, push it, and emit `tool_call_end` with it. If the TUI should not render a row for cancelled calls, add a `cancelled: true` flag to the event instead of suppressing it. Add a regression test in `test/session_persist.test.ts` using the abort-on-`tool_call_start` pattern above.

### 2. `test/session_persist.test.ts:105` — abort test never reaches tool-call path

The only abort test aborts before any turn. It never reaches the tool-call path, which is why the bug above slipped through. The new test for finding #1 closes this.

### 3. `src/agent/agent.ts:153` — no Agent-level test of the shared session option

The recorder's once-only history seeding is tested with hand-built seeds, but nothing checks that two `agent.run` calls with the same handle produce one file, no duplicated history, and `session_path` equal to the handle path, or that omitting `session` still opens a fresh file per run. This is the wiring `options.session === undefined` depends on.

### 4. `src/session/recorder.ts:102` — provider throw leaves dangling user message (low)

A provider throw leaves a transcript ending in a dangling user message. Documented in `library.md`, but the resume side does not handle it: `read_session_messages` replays that trailing user message and the next turn appends another, so the resumed conversation has two consecutive user turns. Low severity since most providers tolerate it.

**Hint:** either write a `run_error` meta on the throw path, or have the resume loader drop a trailing user message.

### 5. `src/session/recorder.ts:80` — `history_size` semantics changed silently

Old value was the post-run message count; the new one is the pre-run seed count. No code or recipe consumes it, so no breakage, but `agent-loop.md` should say what it now means.

## Merge-order note (not a defect)

PR #66 is based on `main`, not on this branch. A three-way merge of the two branches conflicts in `CHANGELOG.md`, `docs/user-guide/cli.md`, and `src/tui/app.tsx`. Whichever lands second needs a rebase.
