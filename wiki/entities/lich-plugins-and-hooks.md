---
title: Lich plugins, hooks and the gatekeeper
created: 2026-09-23
updated: 2026-09-23
type: entity
tags: [plugins, security, runtime]
sources: [raw/audits/2026-09-23-core-engine-audit.md, raw/audits/2026-09-23-game-surface-audit.md]
confidence: high
---

# Lich plugins and hooks

A plugin is `{name, tools?, hooks?}`, loaded from paths listed in `config.plugins` by `create_agent_with_plugins`. The bare `create_agent` does not load plugins.

## Hooks

- **`before_tool_call`** can veto. A veto becomes a tool error whose text starts with `blocked_by_plugin:`.
- **`after_tool_call`**, **`on_run_start`** and **`on_run_end`**.

There is **no hook that sees the prompt or the messages**. A plugin therefore cannot inject memory, skills or world state before an LLM call. Adding `before_llm_call` and `build_system_prompt` hooks is item 7 of #113 §2c. Hermes gets the same effect with prompt tiers; see [[prompt-cache-tiers]].

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
