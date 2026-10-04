---
source_url: file://lich/REVIEW-pr68-herdr.md (untracked, copied 2026-09-23)
ingested: 2026-09-23
sha256: 08fe41f9bafb27c55aa679e552742290f64a3931e0f9771993ead9ccb56db5f4
---
# Review: PR #68 — docs: sync 0.8.0 for review D-1/D-2/D-3 (#45)

Repo: Moikapy/lich · Branch: `feat/review-docs-45` → `main` · Docs-only PR. Reviewed at PR head, based on the current origin/main tip (no divergence, no conflicts).

## VERDICT: PASS

### Verification performed (each doc claim checked against `src/` on the PR head)

| Claim | Source | Result |
| --- | --- | --- |
| Package and published version are 0.8.0 | `package.json:3`; `npm view @moikapy/lich version` → `0.8.0` | Correct |
| `terminal_timeout_ms` is injected as `LICH_TERMINAL_TIMEOUT_MS` but unused by `terminal` | `src/agent/agent.ts:111` injects; `src/tools/builtin/terminal.ts` never reads it | Correct |
| `terminal` `timeout_ms` arg default 60000, max 300000 | `terminal.ts:18-19` | Correct |
| `LICH_DOCS_DIR`: dir with `index.md`, or parent containing `docs/`; else `<work_dir>/docs` or package docs | `src/tools/builtin/docs_read.ts:43-94`, `index.ts:39` | Correct |
| `LICH_GATEWAY_HOST` default `127.0.0.1`; non-loopback requires `LICH_GATEWAY_TOKEN` | `src/gateway/webhook.ts:13,32,194-201`; `runner.ts:93` | Correct |
| Gateway tools default to a read-only subset | `src/agent/config.ts:23-24` (`DEFAULT_GATEWAY_TOOLS_ENABLED`) | Correct |
| Public platforms default-deny until allowlisted | `src/agent/config.ts:19-22` | Correct |
| Wards are lexical + realpath, symlinks inside the tree allowed, symlink leaves rejected for writes | `src/tools/guard.ts:30-53` | Correct |
| `/resume` slash command exists | `src/tui/state.ts:324` | Correct |
| MCP refuse list is a footgun guard; `bash -c` / `env npx` wrappers not covered | consistent with `src/mcp/mcp_refuse.ts` header on main | Correct |
| Games pacing note: `.ts` is record write time | consistent with the incremental recorder | Correct |

---

### Findings

#### 1. `README.md:52`, `README.md:135`, `docs/getting-started.md:30`, `docs/user-guide/cli.md:88`, `docs/user-guide/cli.md:151` — the "plausible" Anthropic example id is a deprecated snapshot

**Why:** D-2's stated goal is to use model ids a provider accepts. `claude-sonnet-4-20250514` is the dated snapshot of Claude Sonnet 4, which is listed as **Deprecated** in Anthropic's current model list; new users copying it will hit retirement sooner than any current id. The OpenAI example (`gpt-4o-mini`) is fine.

**Fix hint:** Use a current alias such as `claude-sonnet-4-6` (or `claude-sonnet-5`) in all five places; for the OpenRouter example use `anthropic/claude-sonnet-4-6`.

#### 2. `examples/persona_orchestrator/README.md:42` — contradicts the new trust-model table (not in this PR's file list)

**Why:** The README's new Trust model row says the webhook "binds loopback by default", which matches `src/gateway/webhook.ts:13`. The persona example README still says the CLI webhook is "`8089` on `0.0.0.0`". Since D-1/D-3 is a docs sync pass, this is the one remaining stale statement on the same topic. PR #69 touches that file too, so whichever lands second should carry the one-line fix.

---

### Notes (no action required)

- CHANGELOG `0.8.0` heading with the "(unreleased)" suffix removed matches the registry.
- `docs/architecture/tools.md:45` note about `LICH_TERMINAL_TIMEOUT_MS` duplicates the cli.md table entry; harmless.
- `docs/user-guide/cli.md:31` still describes `lich update` without the `local` install kind from PR #74 (unmerged); nothing to do here until that lands.
