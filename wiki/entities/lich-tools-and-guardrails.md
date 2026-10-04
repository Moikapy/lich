---
title: Lich tools, executor and guardrails
created: 2026-09-23
updated: 2026-09-23
type: entity
tags: [tools, security, runtime]
sources: [raw/audits/2026-09-23-core-engine-audit.md, raw/audits/2026-09-23-game-surface-audit.md]
confidence: high
---

# Lich tools and guardrails

## Execution path

The executor is `HookedToolRunner`, which runs before/after hooks (see [[lich-plugins-and-hooks]]) around a `ToolExecutor`. The `ToolExecutor`:
- never throws
- returns `unknown_tool` for unregistered names
- applies a 30 s default timeout, overridable per tool
- links that timeout with the caller's abort signal
- clamps output at 20k characters

It also:
- runs tools sequentially
- has no concurrency-safe flag on tools
- does no validation of arguments against the schema; each tool hand-coerces with `require_string_arg` and similar helpers

`ToolContext` is `{work_dir, env, signal}`. It carries **no session or NPC identity**, which blocks per-NPC memory and actions; see [[npc-memory-namespaces]].

## Builtins

`read_file`, `write_file`, `edit_file`, `list_dir`, `terminal`, `grep_files`, `fetch_url`, `web_search`, `http_request`, `process_list`, `disk_usage`, `env_get`, `docs_read`, `docs_search`, `run_tests`. The gatekeeper plugin adds `git_commit`.

## Guardrails (the "wards")

- **File tools:** realpath confinement to `work_dir`, and writes to `.lich/config.json` are denied.
- **Network tools:** an SSRF guard blocks private and loopback URLs unless `LICH_ALLOW_PRIVATE_URLS=1`, and redirects are re-checked.
- **`terminal` is not sandboxed.** It runs `bash -lc` in `work_dir` with secret env vars scrubbed. The docs say this plainly.

## Known holes (open on v0.9.0)

- **`tools_enabled` doesn't restrict plugin tools.** It is applied before plugin tools and `git_commit` are registered.
- **A throwing `before_tool_call` hook lets the call through** (fail-open), and hooks have no timeout.
- **S-11:** `http_request` always returns `ok:true`; `guard.ts:12` checks `startsWith("..")`; `terminal_timeout_ms` is dead code.
- **`docs_read` resolves its root from `process.cwd()`** and memoizes it globally.

These holes are why the embedded profile starts with no builtins at all; see [[embedded-safety-profile]].

Related: [[lich-agent-loop]], [[lich-mcp]].
