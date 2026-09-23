---
source_url: file://lich/REVIEW-pr76-herdr.md (untracked, copied 2026-09-23)
ingested: 2026-09-23
sha256: edb07219839c2318504afed7652701ae4187f84bb4309629e4757f172e65fcae
---
# Review: PR #76 — fix(tools): REVIEW should-fix S-6..S-9 (process kill, ReDoS, HTTP clamp)

Repo: Moikapy/lich · Branch: `feat/review-tools-39` → `main` · Reviewed at PR head (up to date with origin/main)

## VERDICT: FAIL

### Verification performed

- Full vitest suite on the PR head: 404 passed, 2 failed. Both failures are environment-only (review worktree lives under `/tmp`, which one test asserts against; the other needs a built `dist/`). Neither touches PR code.
- `tsc --noEmit`: clean.
- `engines.node >= 20` covers `AbortSignal.any` (Node 20.3+).
- Sound and not flagged: process-group kill (`kill -pgid` on detached spawn), run_tests timeout/abort with mutex release in `finally`, `terminal_result` no longer reporting `ok:true` on timeout, streaming byte clamp in `read_clamped.ts`, `web_search` body cap, `max_results` ceiling.
- Empirical checks (throwaway vitest files, removed afterward):
  - grep tool vs system grep on `src/tools/builtin/grep_files.ts`: pattern `signal\?: AbortSignal` → tool 4 hits, grep 6 hits.
  - grep timing: single ~330-line file 120–400 ms; tree search over `src` 8.2 s.
  - `exit` vs `close`: 15/15 raw detached spawns had all stdout bytes before `exit`; terminal tool retained the final line in 20/20 small-output runs. An earlier 20/20 "loss" was the 20000-char output clamp, not the event change.

---

### Findings (most severe first)

#### 1. `src/tools/builtin/grep_files.ts:96` — non-literal regexes are tested only against the first 22 characters of long lines (CONFIRMED regression)

**Why:** `line_matches` treats any pattern containing a space, backslash, or metacharacter as non-literal (`is_literal_pattern` allows only `[A-Za-z0-9_./:@-]`). For lines longer than `SAFE_REGEX_CHARS` (22), such patterns are probed only on `capped.slice(0, 22)`. Any match starting past column 22 is silently missed. Nearly every real regex the agent issues on real source lines returns incomplete results with no indication.

**Repro:** `signal\?: AbortSignal` on grep_files.ts → tool returns 4, `grep -cE` returns 6.

**Fix hint:** Remove the prefix probe. Bound ReDoS by rejecting nested-quantifier patterns up front (e.g. `(x+)+`, `(a|a)*`), or run the full capped line under the VM timeout. Add a test with a fixture whose matches sit past column 22 for a pattern containing a space and a metacharacter, asserting the exact hit count.

#### 2. `src/tools/builtin/grep_files.ts:76` — a fresh VM context is created for every line tested (CONFIRMED perf regression)

**Why:** `vm.runInNewContext(...)` builds a new V8 context per call (~1 ms each). Every line ≤22 chars, and every long line with a non-literal pattern, pays this. Tree searches go from tens of milliseconds to multiple seconds.

**Repro:** tree search over `src` with `use_agent_run\(` → 8.2 s.

**Fix hint:** Create one context with `vm.createContext()` at module load, compile `re.test(line)` once via `new vm.Script(...)`, and call `script.runInContext(ctx, { timeout })` per line, assigning `ctx.re`/`ctx.line` before each call. Preferably validate the pattern once and use plain `regex.test` for the common case.

#### 3. `src/tools/read_clamped.ts:26` (via `src/tools/builtin/fetch_url.ts:60`) — pages whose Content-Length exceeds the byte budget are rejected instead of clamped (regression)

**Why:** `read_clamped_text` calls `reject_oversized_content_length` unconditionally. `fetch_url`'s budget is `min(400 KB, max_chars * 4)` = 80 KB by default. Any static/CDN page above 80 KB that sends Content-Length now returns `body_too_large` where it previously returned the first 20000 chars. That breaks fetching most documentation and article pages. The streaming reader already bounds memory, so the header check adds no safety.

**Fix hint:** Drop the `reject_oversized_content_length` call from `read_clamped_text` and rely on the stream clamp. Keep the exported function if `http_request` wants opt-in rejection. Update the S-9 test `fetch_url fails closed on oversized content-length via mock` to assert clamped output instead.

#### 4. `src/tools/builtin/terminal.ts:103` and `src/tools/builtin/run_tests.ts:66` — detached children outlive a killed parent

**Why:** `detached: true` places the child in its own session/process group, so SIGINT/SIGTERM delivered to lich no longer reaches a running command. The abort-driven `kill_process_group` fires only on a clean caller abort, which does not happen on a hard signal in one-shot or gateway mode. Previously the child shared the parent's group and died with it.

**Fix hint:** Keep a module-level set of live children and SIGKILL their groups from `process.on("exit")` plus SIGINT/SIGTERM handlers; or avoid `detached` and only use `kill(-pid)` after confirming the child is a group leader.

#### 5. `src/tools/builtin/terminal.ts:86` and `src/tools/builtin/run_tests.ts:73` — resolving on `exit` instead of `close` can drop trailing output (low, not reproduced)

**Why:** Node documents that stdio may still be open when `exit` fires. Could not reproduce a loss in 35 runs on this machine, so low priority, but it is a latent nondeterminism.

**Fix hint:** Await `close` and rely on the process-group kill to guarantee `close` fires on timeout; fall back to `exit` only if `close` does not arrive within a short grace period after the kill.

#### 6. `test/tools_review_shouldfix.test.ts` — no test checks grep correctness (missing test)

**Why:** The S-8 tests cover only return speed on a pathological regex and the `max_results` ceiling, which is why finding #1 passed CI.

**Fix hint:** Add a fixture file with matches at columns 5, 30, and 80; assert exact hit counts for (a) a literal pattern, (b) a pattern with a space, (c) a pattern with `\(` or `\?`. Also assert tool hits equal a precomputed count for a multi-file tree.

---

### Notes (no action required)

- `match_lines` caps the line and `line_matches` caps it again; redundant but harmless.
- In `terminal.run_command`, the timeout path calls `kill_process_group` after `wire_kill` already registered the same kill on the timeout signal; double SIGKILL is harmless.
- `read_clamped_text` on a `null` body slices by characters rather than bytes; cosmetic.
- `run_tests` per-chunk clamp (`append_clamped`) is equivalent to the old post-hoc clamp because `truncate_text` keeps the head; no behavior change.
