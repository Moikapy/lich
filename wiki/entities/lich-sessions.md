---
title: Lich sessions (the phylacteries)
created: 2026-09-23
updated: 2026-09-23
type: entity
tags: [sessions, runtime, games]
sources: [raw/audits/2026-09-23-core-engine-audit.md, raw/audits/2026-09-23-game-surface-audit.md]
confidence: high
---

# Lich sessions

Transcripts are stored as JSONL under `.lich/sessions/` (`src/session/store.ts`, `recorder.ts`, `resolve.ts`).
- Each record is `{ts, kind: "message"|"meta", …}`.
- The recorder appends incrementally, as events arrive.
- Resume is available through `lich --resume <id>` and the TUI `/resume`.
- Filenames look like `<base36-ts>-<counter>[-<label>].jsonl`. On v0.9.0 the session id includes the pid plus a random part (A-12).

## Use in games

`docs/user-guide/games.md` treats a session file as a **combat log** and queries it with jq recipes (rationale, action histogram, vetoes, usage). This is the only replay Lich has: there is no seed or RNG replay.

The play harness proposed in #113 §4(B) needs more than that:
- recorded observations
- pinned seed and temperature
- `lich replay`

**Watch out for supersets:** each gateway run without a shared session handle writes a file that contains all prior history. Globbing `*.jsonl` therefore double-counts.

## Compared with Hermes

Hermes stores sessions in SQLite with WAL and FTS5, and provides a `session_search` tool. Lich has no search. The proposal is to keep JSONL as the replay log and add an FTS index beside it (#114, item 7). See [[lich-vs-hermes]].

Related: [[lich-agent-loop]], [[game-bridge-example]].
