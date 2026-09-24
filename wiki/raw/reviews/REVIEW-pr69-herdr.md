---
source_url: file://lich/REVIEW-pr69-herdr.md (untracked, copied 2026-09-23)
ingested: 2026-09-23
sha256: cd8e7035547c49fc6914d61d7a8952a2190bfa6ac1423d74c592e06c3f86b9a9
---
# Review: PR #69 — fix(examples): require persona orchestrator auth (E-1)

Repo: Moikapy/lich · Branch: `feat/review-examples-44` → `main` · Reviewed at PR head, based on the current origin/main tip (no divergence, no conflicts).

## VERDICT: PASS

### Verification performed

- Full vitest suite on the PR head: 435 passed, 2 failed. Both failures are environment-only (review worktree under `/tmp`; unbuilt `dist/`). Neither touches PR code.
- `tsc --noEmit`: clean.
- Sound and not flagged: `run.ts` refusing to start without `LICH_GATEWAY_TOKEN` / `LICH_PERSONA_TOKEN`; `start_persona_server` rejecting a blank token; `x-lich-token` now mandatory (401 covered at test/persona_orchestrator.test.ts:221); `Host` loopback check with bracketed IPv6 and optional port; `Content-Type` check ignoring parameters (415 tested); streaming body cap with 413 (tested at 64 bytes); `enqueue` evicting settled chain entries with an identity check (tested); README updated for token, 415, and 413.

---

### Findings (most severe first)

#### 1. `examples/persona_orchestrator/history_queue.ts:18` — `cap_history` can discard the whole window

**Why:** After slicing, the new loop advances until it finds a `user` message. A persona run that spends many turns in tool calls (assistant → tool → assistant → tool …) can have no `user` message inside the last `cap` entries, so the function returns `[]` and the next turn starts with no history at all. The orphan problem it fixes only concerns `tool` messages whose parent assistant was cut; an assistant carrying `tool_calls` followed by its own tool results is a valid window start.

**Fix hint:** Skip leading messages only while `role === "tool"` (and, if you want to be strict, a leading assistant whose `tool_calls` results are not all present). Add a test where the capped window contains no `user` message and assert history is retained rather than emptied.

#### 2. `examples/persona_orchestrator/README.md:42` and `examples/persona_orchestrator/server.ts:3` — stale claim that the CLI webhook binds `0.0.0.0`

**Why:** main's webhook binds `127.0.0.1` by default (`src/gateway/webhook.ts:13`, `DEFAULT_GATEWAY_HOST`) and refuses non-loopback binds without a token. The sentence contradicts the trust model PR #68 adds to the README. One-line doc fix, stated, not applied: change "`8089` on `0.0.0.0`" to "`8089` on `127.0.0.1` by default" in both places.

#### 3. `examples/persona_orchestrator/server.ts:118` — oversized bodies are drained to completion before the 413

**Why:** `read_body` flags overflow but keeps consuming until `end`. A client streaming many megabytes without `content-length` occupies the handler for the whole upload. Low severity for a loopback example.

**Fix hint:** Reject as soon as `size > max_body_bytes` and call `request.destroy()` after responding, or pre-check `content-length` like `src/gateway/webhook.ts` does.

---

### Missing tests

- End-to-end `Host` rejection: only the `host_is_loopback` unit is tested. Add a request with `Host: evil.example` and assert 400 `invalid host`.
- `cap_history` with no `user` message in the window (finding 1).
- `run.ts` `require_token` throwing when both env vars are unset (cheap to cover by exporting `require_token` or invoking `main` with a stubbed env).

---

### Notes (no action required)

- `host_is_loopback("::1")` without brackets returns false; RFC 7230 requires brackets for IPv6 in `Host`, so this is correct.
- Making `token` a required field of `ServerParams` is a breaking change for any external caller of `start_persona_server`; the PR updates the in-repo callers and the README, which is the intent of E-1.
