---
source_url: file://lich/REVIEW-pr65-herdr.md (untracked, copied 2026-09-23)
ingested: 2026-09-23
sha256: 328de44b8924978fbe70d3d064dcd51140a66ab694d64f8879a08d461e3eab09
---
# Herdr Claude review — PR #65 (session resume Phase 1)

Source: Herdr pane `w6590b22082fb22:p2` (Claude), 2026-09-22.

## VERDICT: PASS

No correctness bugs or regressions found on PR head. Persistence still post-run is accepted as Phase 2.

## Actionable findings

1. **test/session_resolve.test.ts** — exact-match precedence not actually tested. Add ids `abc` and `abc-2`, value `abc` → must resolve `abc.jsonl`, not ambiguous.
2. **src/cli.ts `run_tui_entry`** — no test that `tui --resume latest` resolves, reads, and calls `run_tui` with `initial_history` / `resumed_id` (mock `../src/tui.js` like first_run / cli_plugins).
3. **src/tui/app.tsx** — history seeding into the first `agent.run` is untested; only `split_history_blocks` is covered. State the gap or add a test.
4. **src/tui/app.tsx banner** — count includes system/tool messages; UI may show fewer blocks. Clarify semantics (e.g. non-system count) if user-facing.
5. **src/session/resolve.ts** — readdir failures look like “session not found (none)”; include `dir` in the error / propagate non-ENOENT.
6. **src/cli.ts** — `--resume` silently ignored by `init` / `config` / `mcp` / `update`; docs say outside-TUI fails. Guard after first dispatch when resume is set and command is not `tui`.
