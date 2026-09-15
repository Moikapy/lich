# Council Review R2 — Simplicity & Value

## Verdict

APPROVE-WITH-CHANGES — All four round-1 cuts landed and the scope is now close to the minimal loop. Two pieces of fresh gold-plating remain: the HEAD+index-hash seal (over-complex, and as specified it doesn't even do what it claims) and the `docs_roots` config knob (a hardcoded constant suffices).

## Round-1 findings status

1. Skills tools (rebadged docs tools) — RESOLVED: skills are `write_file` + `docs_search`; residual `docs_roots` config flagged below.
2. LLM consolidation/reflector — RESOLVED: cut entirely; agent appends its own dated lines; zero LLM pipelines.
3. `repo_status` — RESOLVED: cut; documented `terminal git status` recipe.
4. Milestone collapse — RESOLVED: single v0.4.0 release; the e2e demo is the acceptance test.
5. `git_commit` + gatekeeper (kept) — RESOLVED: kept as the named choke point; see finding 1 on the seal replacement.

## New blocking findings in v2

1. **HEAD + index-hash seal — high — gold-plated and mis-specified.** (a) As written it doesn't work: `write_file`/`edit_file` edits never touch the git index (only `git add` does), so "tests → edit → commit" still passes an index-hash check; catching it requires hashing the tracked *worktree* (`git stash create`-style plumbing). (b) The gatekeeper would shell out to git from inside an `after_tool_call` hook to capture state — new subprocess failure modes on NFS (this user's actual mount) for marginal value. Simpler, equally safe for v1: naive run_state dirty tracking — `on_run_start` sets `tests_ok=false`; `after_tool_call` on any file-writing tool (`write_file`, `edit_file`) sets `dirty=true`; a green `run_tests` clears both; veto `git_commit` unless `!dirty && tests_ok`. ~20 lines inside the gatekeeper, no git plumbing, and it closes the primary TOCTOU (the agent's own edit-after-test path). The residual gap — edits via raw `terminal` — is already inside v2's documented honest floor. If a state hash is ever revisited, hash worktree state, not the index, and say so precisely.

2. **`docs_roots` config knob — medium.** Cost: a new zod key, ordered multi-root semantics, per-root cache invalidation, plus a hidden wrinkle v2 doesn't mention — `dir_with_index` in `src/tools/builtin/docs_read.ts` requires an `index.md`, which `.lich/skills/` will never have, so the existing validator rejects the skills root outright. And the justification leans on "makes plugin-bundled docs work" — solving an unrequested second problem to pay for the mechanism. Simpler: hardcode it — append `<work_dir>/.lich/skills` to the candidate chain in `default_resolve_docs_root` (relaxing the index.md gate for that candidate) and have `docs_search` merge the skills dir as a second scored source. A couple of constants, no config, no docs page. Promote to config only when a second consumer appears.

## Non-blocking observations

- `max_commits_per_run` became config-tunable (min/max/zod/docs) — my Q3 answer was "hardcode 1 until proven wrong." Revert.
- Terminal denylist: worth keeping only because it stays hardcoded (Q7's default proposal is correct; no `deny_command_patterns` config in v1). Drop `remote` from the regex — `git remote -v` is harmless recon the agent legitimately uses; `commit|push` are the real bypasses.
- Per-tool `timeout_ms`: approved as the minimal form of a necessary change — an optional field defaulting to today's 30s executor cap beats name-based special-casing in the executor; only `run_tests` sets 600000.
- Ship `git_commit` as the gatekeeper plugin's own `tools` entry (loader already supports this — `src/plugins/loader.ts`, `docs/user-guide/plugins.md`) instead of inventing an auto-loaded "builtin plugins" concept for `src/plugins/builtin/`; no gatekeeper listed → literally no `git_commit` tool.
- e2e negative paths (commit-before-tests, edit-without-retest) belong in gatekeeper unit tests; keep the two-process e2e to the happy path. Process B (fresh-load verification) is justified — it's the half that honestly proves the module-cache reality.
- Secret-basename blocklist and the `run_tests` concurrency mutex: small, hardcoded, motivated by the real NFS environment — fine.
- Conventions: the dirty-tracking gatekeeper fits the 60-line hook rule with room to spare; no recursion; zero new dependencies. The seal version strained the line budget and added git subprocess calls inside hooks — one more reason to cut it.
- Q8: explicit `run_tests` call only — auto-run-before-commit is a magic dependency chain that makes veto behavior harder to reason about.
- What I checked for new bloat and cleared: `git_commit` arg guards (paths 1..50, secret-ish names, HEAD check), fail-closed registration, run_state plumbing (also fixes the real "no context passed today" bug), memory/skills as conventions-not-machinery, single-milestone plan, NFS retry notes.

## Minimal version check

v2 matches round-1's minimal version in shape — 2 tools, 1 plugin, 0 skill tools, 0 memory machinery, 1 milestone — plus two justified additions my r1 list lacked: per-run `ToolContext`/`run_state` plumbing and the two-process e2e. Residual cuts to converge: (1) seal → dirty flag, (2) `docs_roots` → hardcoded resolver candidate + merged skills source, (3) `max_commits_per_run` → hardcoded 1, (4) denylist regex minus `remote`. With those four, v2.1 is exactly the r1 minimal version.