# Council Review R3 — Simplicity & Value

## Verdict
APPROVE — All four round-2 cuts landed as specced, and every surviving v3 addition (env-channel knobs, loader collision check, symbol state channel, `git commit --only`) is either reviewer-mandated or a net simplification. What remains are four non-blocking notes on spec precision, none of which add machinery.

## Round-2 blockers status
1. Seal → dirty flag — RESOLVED (ruling S-1: no git subprocess in hooks; attestation sentence stated, not implied; upgrade path recorded so the git mechanics are never re-derived wrong).
2. `docs_roots` → hardcoded resolver candidate — RESOLVED (delta 2: no zod, index.md gate relaxed for that candidate, fresh-walk only for the user-writable root; package docs keep their cache).
3. `max_commits_per_run` → hardcoded 1 — RESOLVED (`commits < 1` in the veto condition; zero knobs).
4. Denylist minus `remote` — RESOLVED (delta 9: stays hardcoded, gains only flag-tolerance + `commit-tree`/`update-ref` — correct hardening, one alternation).

## Ruling on S-1 (your chair's dirty-flag proposal) and the symbol-keyed state channel
ACCEPT-WITH-NOTES — S-1 is the r2 mechanism adopted whole (structured-`ok` gate, no agent assertion, honest floor documented). The symbol channel is within budget: ~15 lines in `plugins/hooks.ts`, and it *removes* a required "trust third-party plugins" caveat rather than adding a concept — the fallback (per-plugin string sub-maps + documented distrust) pays a documentation convention to keep open a hole 15 lines close; it loses. Notes: implement as a module-internal WeakMap keyed on the plugin object (same line count, no symbol property to enumerate), keep `with_hook_state`/`hook_state_for` unexported, never generalize into a public state API. The specced gatekeeper itself (state init + 3 after-hook cases + 2 veto cases + regex) is ~35-40 lines — inside the 60-line house rule with room.

## New findings in v3
1. Pin the env sourcing in one sentence: the loop-fix bullet says per-run ToolContext is "work_dir + env from config" while `LICH_TEST_COMMAND`/`LICH_ALLOW_SELF_COMMIT` must originate from `process.env` — state that the env map is assembled in code (config-derived `LICH_TERMINAL_TIMEOUT_MS` + process-env knobs) and never gains a config passthrough. The knobs themselves are acceptable, not bloat: zero zod, unset→false fail-closed, and the agent cannot mutate its parent's env, so no runtime override exists; the e2e fixture repo also needs `LICH_TEST_COMMAND`. Stale cite: the env channel is `src/agent/agent.ts:114` (file is 84 lines, not 110-113).
2. "Gatekeeper reads the structured `run_tests` result" needs its additive hook change spelled out: `AfterToolCallInfo` today carries only a 300-char `result_summary` (clamp in `plugins/hooks.ts`), so structured gating requires extending after-hook info with `ok`/`error` (~3 additive lines). Specify that — not summary-string parsing, which is the brittle transcript-matching r1 rejected.
3. Loader collision check is smaller than delta 4 implies: current code already hard-rejects duplicate names among *config* plugins (`loader.ts:91-95` `seen` set → `duplicate_plugin_name` error); the only new code is a builtin-names membership test. Keep it a hardcoded frozen list — no registry machinery.
4. Checked for smuggled machinery and cleared: `git commit --only` (removes a separate staging step — net simpler); two-process e2e (r2-endorsed Process B; negative paths already moved to gatekeeper unit tests per my r2 note); fresh-walk skills dir (the agent writes a skill then must find it — a cache would break the loop's own demo); boundary sentence, secret blocklist, busy mutex, terminal 300s timeout (r2-cleared or one-liners). No zod keys anywhere in the final spec.

## Minimal version check
v3 is the minimal version: 2 tools, 1 plugin, 0 skill tools, 0 memory machinery, 1 milestone — every surviving line maps to an r1/r2-cleared necessity or a reviewer-mandated security fix; ship it.