# PR #101 review record — session RPC (issue #82)

Captured 2026-09-23. Head at capture: `3953e58` (fix commit on `410fb20`).

## Sources

1. Cursor Automation PR REVIEW (bot) — two `CHANGES_REQUESTED` bodies
   (initial `d3b439d`, re-review after rebase onto `main`).
2. Deep code-review subagent (Cursor `code-reviewer`) — VERDICT: **PASS**,
   11 findings (3 should-fix, 5 suggestion, 3 nit) + test gaps.

## Bot findings and disposition

| Finding | Disposition in `3953e58` |
| --- | --- |
| Warning: `bags` map only grows; leak in long-lived serve | Fixed — LRU cap (default 32, `max_session_bags` option), `dispose()` on `ServeServer.stop()`, eviction logged |
| Suggestion: `session.resume` should return `resumed_id` | Fixed — added to `SessionResumeResult` |
| Suggestion: resume hard-codes `source: "resume"` | Fixed — optional `source` in `SessionResumeParams` |
| Suggestion: `session_dir` default diverges from `AgentConfig` (`work_dir`) | TODO(#84) comment at the default in `server.ts`; docs note; CLI must pass `config.session_dir` |
| Suggestion: `-32000` errors echo absolute paths/candidates | Fixed — `ServeSessionError` with stable client text; details logged server-side via `logger.warn` |

## Deep-review findings and disposition

| # | Finding | Disposition |
| --- | --- | --- |
| 1 | should-fix: per-frame `await` → out-of-order replies; `void` can crash on rejection | Fixed — per-connection promise tail serialization + `.catch` → `logger.warn` |
| 2 | should-fix: unbounded `bags` with no eviction path | Fixed — same LRU/dispose as bot warning |
| 3 | should-fix: stale docs paragraph contradicts implemented `session.resume` | Fixed — paragraph rescoped to `prompt.*`; fork-on-resume, clear semantics, LRU documented |
| 4 | suggestion: repeat resume forks conversation; undocumented | Documented as intended (matches CLI `--resume`); `resumed_id` added |
| 5 | suggestion: `clear` is in-memory only; on-disk transcript survives | Documented in serve.md; full contract decision deferred to #83 |
| 6 | suggestion: unreadable transcript resumes "successfully" with 0 messages | Fixed — `read_session_messages` rethrows non-ENOENT; resume maps to `unreadable` `-32000` |
| 7 | suggestion: `session_dir` default duplicates config default | TODO(#84) + docs (same as bot) |
| 8 | nit: `-32000` leaks absolute paths | Fixed (same as bot) |
| 9 | nit: `{label: ""}` accepted while `{session_id: ""}` rejected | Fixed — `parse_session_create` rejects empty label |
| 10 | nit: large transcript doubles footprint on resume (`[...messages]` copy) | Not fixed — copy is intentional (no aliasing); history capping deferred to #83 where it's consumed |

## Test gaps closed in `3953e58`

- LRU eviction beyond cap + `dispose()` drops all bags
- `session.resume` missing id and ambiguous prefix → clean `-32000` text
- Path-traversal pin: `id: "../secret"` → not found, no outside read
- Empty-label create rejected; optional resume `source` round-trip
- Meta/malformed transcript lines filtered on resume
- WS-level `session.create`/`session.resume` round-trip through `create_serve_server`
- Pipelined frames replied in order per connection

## Deferred (tracked, not blocking)

- History-size cap on resume (#83) — finding 10
- On-disk `clear` contract (#83) — finding 5
- `config.session_dir` wiring (#84) — finding 7 / bot session_dir
- Large-transcript streaming (#83, if needed)