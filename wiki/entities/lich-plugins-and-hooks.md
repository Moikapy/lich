---
title: Lich plugins, hooks and the gatekeeper
created: 2026-09-23
updated: 2026-10-03
type: entity
tags: [plugins, security, runtime]
sources: [raw/audits/2026-09-23-core-engine-audit.md, raw/audits/2026-09-23-game-surface-audit.md, raw/audits/2026-10-02-hermes-models-memory-decisions.md, "#149", "#157"]
confidence: high
---

# Lich plugins and hooks

A plugin is `{name, tools?, hooks?}`, loaded from paths listed in `config.plugins` by `create_agent_with_plugins`. The bare `create_agent` does not load plugins.

## Hooks

- **`before_tool_call`** can veto. A veto becomes a tool error whose text starts with `blocked_by_plugin:`.
- **`after_tool_call`**, **`on_run_start`** and **`on_run_end`**.

Since #157 (`1567638`) plugins get three host features that [[hermes-agent]]'s decision and memory plugins rely on:

- **Entry objects.** A `plugins` entry is a bare path or a strict `{ path, settings?, models? }` (`src/agent/config.ts:115@1567638`). Settings are deep-frozen; `models` lists granted roles and defaults to none.
- **Context.** `HookContext` and `ToolContext` carry that plugin's `settings` and `models.chat(role, …)` (`src/plugins/types.ts:32-37@1567638`). An ungranted role is refused; the call honours the run's abort signal (`src/agent/agent.ts:136,320@1567638`). Plugin tools get the same fields through a wrapper at registration.
- **`before_llm_call`.** Runs before each main-loop model call with a deep copy of the history (`src/agent/loop.ts:140@1567638`). A returned note is capped at 2000 chars, labelled with the plugin name, and sent as one trailing system message on that call only; it is never saved. Throwing hooks fail open (`src/plugins/hooks.ts:202@1567638`).

There is still no `build_system_prompt` hook (item 7 of #113 §2c); notes are per call, not a stable prompt tier. Hermes gets that effect with prompt tiers; see [[prompt-cache-tiers]].

Hook state was a module-global WeakMap in v0.8.0. It is **per run via AsyncLocalStorage on v0.9.0**, which fixes the case where concurrent runs clobbered each other's state.

## Gatekeeper (`plugins/builtin/gatekeeper.plugin.ts`)

The gatekeeper is Lich's "self-improvement loop". It allows one `git_commit` per run, and only when all of these hold:
- `LICH_ALLOW_SELF_COMMIT=1`
- `run_tests` passed
- the tree was clean

It also denies certain git operations. It is **not** Hermes-style learning (compare [[memory-vs-skills]]).

## Holes

- Hooks fail open when they throw, and have no timeout.
- `git_commit` is always registered, even with `tools_enabled: []`.
- Plugins run in-process with full privileges.

All three have to change before plugins can be trusted in a shipped game ([[embedded-safety-profile]]).

Related: [[lich-tools-and-guardrails]], [[game-bridge-example]].
