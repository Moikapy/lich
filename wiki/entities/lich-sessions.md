---
title: Lich sessions (the phylacteries)
created: 2026-09-23
updated: 2026-10-19
type: entity
tags: [sessions, runtime, games]
sources: [raw/audits/2026-09-23-core-engine-audit.md, raw/audits/2026-09-23-game-surface-audit.md, "#168", "#194", "#201"]
confidence: high
---

# Lich sessions

Transcripts are stored as JSONL under `.lich/sessions/` (`src/session/store.ts`, `recorder.ts`, `resolve.ts`).
- Each record is `{ts, kind: "message"|"meta", …}`.
- The recorder appends incrementally, as events arrive.
- Resume is available through `lich --resume <id>`, the TUI `/resume` and serve's `session.resume`. Since #201 the TUI shows a resumed transcript in its new layout (one `┊` row per tool call), without run times; `docs/user-guide/tui.md` describes it.
- Filenames look like `<base36-ts>-<base36-pid>-<6 hex>-<counter>[-<label>].jsonl` (`src/session/store.ts:40@0826623`); the pid and random part fixed A-12.

## Resume hygiene

`read_session_messages` (`src/session/store.ts:183@0826623`) cleans a transcript so the next provider call is valid and a serve fork reads back unchanged:
- **Interrupted seeds (#168):** a user line followed by a `meta` record before the next user line never got an answer, so it is dropped. Adjacent user lines stay, because a compression summary is stored that way (`src/session/store.ts:149@0826623`). A trailing run of user lines is dropped as well.
- **Tool pairing (#194):** a tool row is kept only when it answers a call id of the assistant right before it; orphan tool rows are dropped. A call with no result gets a synthetic `cancelled` result (`src/session/store.ts:89-141@0826623`).

Serve applies the same rule in memory after an abort ([[lich-serve]]).

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
