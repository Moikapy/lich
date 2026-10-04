---
source_url: file://lich/REVIEW-pr75-herdr.md (untracked, copied 2026-09-23)
ingested: 2026-09-23
sha256: d8ec8958f51950d7886ce5760856227f1a6eb97665cec6bf48a4d1f06ca43d56
---
# Review: PR #75 — fix(mcp): REVIEW should-fix M-2..M-9 (plugins / gatekeeper / MCP)

Repo: Moikapy/lich · Branch: `feat/review-mcp-40` → `main` · Reviewed at PR head, up to date with origin/main (no divergence, no conflicts).

## VERDICT: FAIL

### Verification performed

- Full vitest suite on the PR head: 423 passed, 2 failed. Both failures are environment-only (review worktree under `/tmp`; unbuilt `dist/`). Neither touches PR code.
- `tsc --noEmit`: clean.
- Every name in the gatekeeper `READ_ONLY_TOOLS` set matches a real builtin tool name (checked against `src/tools/builtin/*.ts`).
- After-hooks do not run for blocked calls (hooks.ts:149 returns before :161), so "dirty on failed writes" means executor failures, which is the intended M-7 semantics.
- Sound and not flagged: id→resolver map with out-of-order settle, `AbortSignal` threading through stdio/HTTP pipes and `call_tool`, 15 s attach deadline, `pin_for` basename fallback for catalog pins and `exclude_tools`, per-run `AsyncLocalStorage` bags with WeakMap fallback and `call_run_start` reset inside the scope, `Agent.run` wrapping `run_body` in `run_scope`, Node stdin EPIPE listener, Bun env merge, metadata caps in `parse_tools`, error-text clamp in `content_text`.
- Empirical probes (throwaway vitest files, removed afterward):
  - `refuse_stdio_command("env", ["-i","bash","-c","x"])` → `undefined` (allowed). `("env", ["-S","bash -c x"])` → allowed. `("node", ["--eval=1"])` → allowed. `("env", ["FOO=1","npx","y"])`, `("node", ["-e","1"])`, `("bun", ["x","pkg"])`, `("/usr/bin/sh", [])` → refused as expected.
  - `stdio_pipe` with a child whose `read_line` returns `undefined`: first request rejects "mcp closed the pipe"; a second request never settles (still pending after 500 ms).

---

### Findings (most severe first)

#### 1. `src/mcp/mcp_pipe.ts:119` — after the child closes, every later request hangs instead of failing fast (regression)

**Why:** `start_pump` exits when `read_line` returns `undefined` or `failed()` is set, rejecting only the waiters pending at that moment. `pump ??=` never restarts it, and `request` still inserts a new waiter and writes to the dead child. Before this PR, `read_id` re-read the pipe per request and threw "mcp closed the pipe" immediately. Now a crashed MCP server turns each subsequent tool call into a wait until the tool's timeout aborts the signal (and `list_tools` during attach only fails because of the separate 15 s deadline). Reproduced above.

**Fix hint:** Keep a `dead: string | undefined` flag set by the pump on exit (with the failure message); in `request`, if `dead !== undefined` reject immediately with it and do not write. Also reject in `close()` for requests made after close. Add a test: child returns `undefined` once, then a second `request` rejects synchronously-ish with "mcp closed the pipe".

#### 2. `src/mcp/mcp_refuse.ts:80` and `:94` — `env` chains bypass the shell refusal via flags or `-S`

**Why:** `refuse_env_chain` returns `undefined` at the first non-`KEY=VALUE` argument that is not a downloader or shell, so `env -i bash …` stops at `-i`. The fallback `refuse_arg_downloaders` skips `-` arguments but only checks `DOWNLOADERS`, not `SHELLS`, so `bash` passes. `env -S "bash -c x"` passes because the basename of the whole quoted string is not a set member. M-4's summary says shells are refused; the `env` path is the documented exception. The file header correctly says this is a footgun guard, not a security boundary, so severity is medium.

**Fix hint:** In `refuse_env_chain`, `continue` on arguments starting with `-` (refuse `-S`/`--split-string` outright), and check `SHELLS` in `refuse_arg_downloaders` too. Add the three probes above as tests.

#### 3. `src/mcp/mcp_refuse.ts:34` — eval flags in `--flag=value` form are not caught; one entry is dead

**Why:** `node --eval=1` and `--eval 1` differ only in form; the set matches whole arguments, so the `=` form passes. `"-c "` (trailing space) can never match a real argument. Low severity.

**Fix hint:** Compare `arg.split("=")[0]` against the set and drop the `"-c "` entry.

#### 4. `src/mcp/mcp_result.ts:26` — an oversized schema is silently replaced by `{ type: "object" }`

**Why:** A tool whose `inputSchema` exceeds 16 KB is registered with no properties, so the model sees a tool it cannot call correctly and gets provider validation errors, with nothing in the logs. Dropping the tool (as is done for oversized names) or logging at warn would make the failure visible. Low severity.

**Fix hint:** Log a warning with the tool name in `tool_schema` when the budget check fails, or skip the tool in `parse_tools`.

---

### Missing tests

- Pipe dead-state rejection (finding 1).
- `env` chain and `--eval=` refusals (findings 2 and 3); the existing M-4 assertions in test/mcp_client.test.ts cover only `env npx`, `bun x`, and `node -e`.
- Attach timeout: no test drives `open_and_register` with a `list_tools` that never resolves; a fake pipe plus `vi.useFakeTimers()` would cover the 15 s deadline and the `session.close()` on timeout.
- `Agent.run` → `run_scope` integration: the new isolation test exercises `HookedToolRunner.run_scope` directly; nothing asserts that two concurrent `agent.run` calls on one Agent keep separate gatekeeper bags end-to-end.
- Node stdin EPIPE handler and Bun env merge are untested (acknowledged as hard to drive; a spawn of `true` with a write after exit would cover EPIPE on Node).

---

### Notes (no action required)

- `with_signal` leaves the pending map entry in place after an abort until the late response arrives or the pipe closes; bounded and harmless.
- Server-initiated JSON-RPC requests (messages with `method` and an `id`) are skipped by the pump, so a server expecting `roots/list` or `sampling/createMessage` replies will wait; pre-existing behaviour.
- `content_text` now clamps MCP outputs to the 20000-char default before the executor's own clamp; consistent with builtin tools.
- CHANGELOG has no entry for the refuse-list expansion, the attach timeout, or the metadata caps.
