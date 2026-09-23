---
title: Embedded (game-safe) safety profile
created: 2026-09-23
updated: 2026-09-23
type: concept
tags: [security, games, npc]
sources: [raw/audits/2026-09-23-game-surface-audit.md, raw/audits/2026-09-23-core-engine-audit.md]
confidence: high
---

# Embedded safety profile

A coding agent needs file and shell access. An NPC shipped inside a game build needs **none**. Today nothing enforces that difference:
- `lich serve` inherits the CLI's `tools_enabled: "all"`.
- `git_commit` ignores `tools_enabled`.
- A hook that throws lets the tool call through.
- Player-typed text reaches the model as ordinary user input.

^[raw/audits/2026-09-23-game-surface-audit.md]

**Proposal** (`safety: "embedded"` on a Profile, #113 §4(C)):
- **No builtins, no `git_commit`, no network.** Only [[client-executed-tools]] and memory tools.
- **Hooks fail closed** and have timeouts.
- **Output caps** (length), with an optional content filter.
- **Player text tagged as untrusted.** It goes in a delimited block, and the system prompt says it is data, not instructions. Hermes' smart approval handles untrusted command text in a similar way.
- **Per-session limits:** token and rate budgets, with real `usage` reported. The webhook currently returns `usage: null`.
- **Loopback plus a token** by default.

**Checklist for users shipping today** (from the drafted doc "choosing a game integration" in #113 §7):
- list only game tools
- don't load the gatekeeper
- keep `max_turns` small
- have a scripted fallback action in game code
- bind to loopback and set a token

Related: [[lich-tools-and-guardrails]], [[lich-plugins-and-hooks]], [[runtime-profile-session]].
