---
title: "0004: DRY policy (dedupe real duplication, merge over-split modules)"
created: 2026-09-23
updated: 2026-09-23
type: decision
tags: [decision, providers, mcp, cli, process]
sources: [raw/issues/issue-113.md, raw/audits/2026-09-23-core-engine-audit.md]
status: proposed
issue: "#113"
revisit_when: "A new provider or adapter is added (check it reuses providers/http.ts rather than copying)"
---

# 0004: DRY policy

## Context

The audit found both kinds of problem. ^[raw/audits/2026-09-23-core-engine-audit.md]

**Real duplication:**
- About 150 lines of HTTP and error helpers are copied across the three providers: `build_abort_signal`, `do_fetch`, `read_response_text`, `parse_retry_after_ms`, `status_to_error_kind`, `error_name`, `is_abort_like`, `describe_error`, `resolve_api_key`, `first_non_empty`. `failover.ts` has its own copies of `error_name` and `is_abort_like`.
- `ToolExecutor.format_result` duplicates `format_tool_result_content` in the loop.
- `split_text` exists in both `gateway/format.ts` and `telegram.ts`.

**Over-splitting:**
- `src/mcp/` has 21 files of 40–60 lines, each with a redundant `mcp_` prefix.
- Seven flat `src/cli_*.ts` files, plus the `gateway.ts` and `tui.tsx` shims.

## Decision

(#113 Addendum 2 §C)

**Do:**
- Extract `providers/http.ts`.
- Delete `ToolExecutor.format_result`.
- Deduplicate `split_text`.
- Consolidate `src/mcp/` into about 5 files (`client`, `transport`, `catalog`, `register`, `safety`).
- Move the `cli_*.ts` files and `setup_wizard.ts` into `src/cli/`, and drop the shims.

**Don't:**
- DRY the per-provider **wire-format mapping**. OpenAI, Anthropic and Ollama change for different reasons, so code that only looks similar isn't duplication.
- Add abstractions for single-use code (CLAUDE.md §2).

## Consequences

- A bug fixed in the provider HTTP handling is fixed once, not in one copy out of three.
- Fewer, more cohesive files make `src/mcp/` easier to read.
- The cleanup PRs touch many files but change no behaviour. They should land after the serve PRs to avoid merge churn ([[0002-serve-pr-merge-path]]).

## Alternatives considered

- **A shared provider base class.** Rejected: it couples three wire formats that evolve independently.
- **Leave it.** Rejected: the three copies already drift from one another.

## Revisit when

- A fourth provider or a new adapter is added. It should reuse `providers/http.ts` rather than copy it.
- Any single module grows past about 400 lines.

Related: [[lich-providers]], [[lich-mcp]], [[0003-subpath-exports-over-packages]].
