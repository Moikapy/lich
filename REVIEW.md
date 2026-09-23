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

---

# Round 2 — bot re-review at 18:03Z on `d2ea008` (4 threads)

Captured 2026-09-23. CI green at head; fixed items above must not regress.

| Thread | Disposition |
| --- | --- |
| `sessions.ts:110` — create/list visibility gap (`.jsonl` only exists after first append; list can't see fresh create/resume-fork ids) | Fixed — serve eagerly touches the transcript (`writeFile` flag `ax`, collision-safe) on `create` and on `resume`'s fork handle; `read_session_messages` parses an empty file to `[]`, so empty transcripts list and resume cleanly (tests: eager-create visible in `session.list`; resume of a just-created empty transcript forks + lists with `message_count` 0) |
| `sessions.ts:147` — dead ENOENT branch (deleted transcript resumed as empty success) | Fixed — root cause was `read_session_messages` swallowing ENOENT into `[]`; the reader now rethrows ENOENT, making the serve read-path branch live → `not_found` (tests: delete-after-create then resume → `-32000 session not found`; store-level rethrow-ENOENT + empty-file→`[]` pins) |
| `server.ts:131` — `stop()`/`dispose()` race (mid-I/O create/resume can `put()` after `dispose()`, leaking a bag across restarts) | Fixed — server-wide in-flight set tracks per-connection handler chains; `stop()` rejects new upgrades, closes clients, drains in-flight before `dispose()` (test: create held mid-I/O while `stop()` runs; `create_done` strictly before `dispose`) |
| `sessions.ts:96` — LRU eviction is log-only; should the client learn a bag was evicted? | Kept log-only (decision): bags are an in-memory cache; the documented client-visible behavior is the next `session.clear` / `prompt.submit` (#83) on an evicted id failing `not_found`, and the transcript stays resumable. serve.md now states this explicitly; no notification mechanism invented (matches instructions: no `event` fan-out until needed) |
