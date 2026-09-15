# Council Review R3 — Architecture & Testability

Reviewer: Council Member 3 (architecture) — plan: `docs/design/self-improvement-loop.md` v3

## Verdict

APPROVE-WITH-CHANGES. All four round-2 blockers are resolved and both open confirmations are
sound; the remaining changes are small but real — adopt the security chair's scoped-add
amendment (delta 8's "no separate add" breaks the demo's own happy path), and resolve the
unborn-HEAD/assertion contradiction and the fixture test-command dependency (findings 1, 4).

## Round-2 blockers status

1. Seal mechanism — RESOLVED. Dirty flag adopted; my corrected temp-index mechanism is
   recorded verbatim as the upgrade path ("hash the worktree, never the index").
2. Core-plugin config plumbing — RESOLVED. Agent-constructed factory fits the existing
   seams (finding 2); tool knobs ride the ExecutorDefaults.env precedent
   (`src/agent/agent.ts:112-115`, env literal at 114) via ToolContext.env.
3. run_tests cwd — RESOLVED. cwd = context.work_dir; the threading point is the bare
   `deps.tools.execute(call.name, call.args)` in run_tool_calls (`src/agent/loop.ts:85-107`,
   execute at 94); a supplied context cleanly supersedes defaults (`src/tools/executor.ts:42`).
4. Process B — RESOLVED. Real bun subprocess; load_plugins resolves relative entries against
   config.work_dir (`agent.ts:210` → `loader.ts:63`) and imports by file URL
   (`loader.ts:67`) — no stale module cache; work_dir-relative fixture paths resolve.

## Ruling on S-1 (dirty flag now, your chair's temp-index mechanism as recorded upgrade path) and the symbol-keyed state channel

ACCEPT-WITH-NOTES. S-1 is clean — the attestation states the terminal floor honestly, and
the upgrade path is mechanically correct as recorded (read-tree HEAD, not the live index,
is the right base — it matches --only's HEAD-plus-named-paths semantics exactly). The
channel is implementable without breaking consumers: HookContext stays { work_dir }
(`src/plugins/types.ts:11-13`), third-party signatures unchanged; hooks.ts swaps its
pick_defined flattening (`src/plugins/hooks.ts:52-58`) for per-plugin entries, each handed
a ctx exposing ONLY its own sub-map via the symbol (a shared bag reopens the forgery
channel via getOwnPropertySymbols). BOTH ctx build sites must share one per-run bag —
the bare lifecycle ctx (`agent.ts:168,177`) and the per-tool ctx (`hooks.ts:90`) — with
the per-run reset in call_run_start (`hooks.ts:108-116`). ~15 lines holds.

## New findings in v3

1. `git commit --only` rejects untracked paths (git 2.55.0 /tmp scratch: pathspec error,
   exit 1) — delta 8's "no separate add" breaks the demo, where every committed file is
   new. Security r3's fix verified: scoped `git add -- <named paths>` then `--only`
   commits exactly those paths (worktree content), leaves pre-existing staged junk.txt
   staged, and works on unborn HEAD; the commits counter is safe (increments on success
   only; a failed commit leaves just the scoped adds staged). Required, same cluster:
   "refuse unreachable HEAD" and "git log shows exactly 1 commit" cannot both hold —
   unseeded fixture means unborn HEAD (a natural rev-parse guard vetoes the demo's own
   commit); seeded means 2 commits. Pick one: seed a harness root commit and assert one
   commit on top of it, or let the guard permit unborn HEAD.
2. Loader hard-reject seam: insert beside the existing duplicate-name error entry
   (`loader.ts:93-96`); the loader has no builtin-name knowledge today (delta 4's
   "replaces warn-and-keep-first" mischaracterizes — that is config-vs-config behavior),
   so either import a BUILTIN_PLUGIN_NAMES const (cycle-free) or thread a reserved-names
   arg into load_plugins; the reject flows through the existing error-entry path, so
   fail-closed holds. Agent wiring: construct once and push as a synthetic LoadedPlugin
   through the unchanged register_plugin_tools/merge_plugin_hooks (`agent.ts:72-84,86-95`).
3. Per-run ToolContext env completeness: a supplied context supersedes ExecutorDefaults
   entirely (`executor.ts:42`), so the loop-built context must carry the same env the
   executor defaults get (`agent.ts:112-115`) — LICH_TERMINAL_TIMEOUT_MS plus
   LICH_TEST_COMMAND — or both knobs silently drop; build it once in Agent and hand it
   over via loop_deps (stub runners ignore the third arg; `loop.ts:27-29`).
4. Fixture dependency hole: the /tmp fixture has no node_modules, so the default
   `node node_modules/vitest/vitest.mjs run` cannot resolve there; the e2e must export
   LICH_TEST_COMMAND as a dependency-free runner (e.g. `bun test`) and the fixture test
   must target that runner's imports.
5. Checked and clean: mutex + `run_tests_busy` fit error_result conventions; terminal
   `timeout_ms: 300000` is a constant swap inside with_timeout (`executor.ts:57-66`);
   skills fresh-walk avoids the single-slot docs_search memoization trap.