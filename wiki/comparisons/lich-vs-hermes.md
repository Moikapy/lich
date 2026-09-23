---
title: Lich vs Hermes
created: 2026-09-23
updated: 2026-09-23
type: comparison
tags: [hermes, ecosystem, research]
sources: [raw/audits/2026-09-23-hermes-vs-lich.md, raw/audits/2026-09-23-core-engine-audit.md, "#113"]
confidence: high
---

# Lich vs Hermes

This compares Lich with [[hermes-agent]], each feature checked against the Lich source at v0.8.0. The **Rec.** column says what Lich should do with each Hermes feature:
- **port:** copy the mechanism, which fits Lich's goals
- **adapt:** take the idea but reshape it, usually for games
- **skip:** not worth it now, or deferred

^[raw/audits/2026-09-23-hermes-vs-lich.md]

| Feature | Hermes | Lich | Rec. |
|---|---|---|---|
| Tool execution | parallel thread pool | sequential (`src/agent/loop.ts:110-118@77bc148`) | **port**: add a `concurrency_safe` flag |
| Toolsets | named sets, `check_fn`, chosen per session | one `builtin` set, flat gateway allowlist | **adapt**: toolsets defined per Profile ([[runtime-profile-session]]) |
| Memory | frozen `MEMORY.md`/`USER.md`, memory tool | none in code | **adapt**: namespaced ([[npc-memory-namespaces]]) |
| Skills | index in the prompt + `skill_view`/`skill_manage` | `.lich/skills` via `docs_search` | **port**: index + view + manage ([[memory-vs-skills]]) |
| Background learning | review fork every N turns, curator | gated `git_commit` only | **port later** (#114, item 7) |
| Session store | SQLite WAL + FTS5 + `session_search` | JSONL | **adapt**: keep JSONL, add an FTS index |
| Prompt caching | 3 tiers + 4 `cache_control` breakpoints | none | **port** ([[prompt-cache-tiers]]) |
| Compression | 2 layers, anchored on real usage, micro-compaction | chars/4 estimate, one layer | **adapt**: calibrate against `usage.prompt_tokens` |
| Subagents | `delegate_task`, depth 1, run in parallel | none | **port**: a game master delegating to NPCs is the same primitive |
| Approvals | pattern/human/LLM, yolo mode | veto hooks only | **adapt**: route `approval_required` to the active surface |
| Interrupts | per thread, steer/redirect | one `AbortSignal` per run | **adapt**: per-tool cancel, queued steer |
| Gateway | ~25 platforms, owns sessions and cron | 4 adapters, one shared Agent | **adapt**: gateway as hub ([[0001-gateway-as-hub]]) |
| MCP | client + server + OAuth | client + catalog + pinning | **skip for now**: server mode deferred (#114, item 8) |
| Terminal backends | local/docker/ssh/modal/… | local `bash -lc` | **skip for now**: Docker deferred |
| Vision / computer use / browser | yes | none | **port**, after content blocks, for use case B |
| Trajectories / batch | ShareGPT JSONL, `batch_runner.py` | none | **port**: `lich export`, `lich bench` |
| Cron | full scheduler + agent tool | none | **skip for now**: sim world ticks later |
| File checkpoints | shadow git | none | **port later**: cheap, useful for coding games |
| UIs | CLI, Ink TUI, Electron, web, ACP | CLI, Ink TUI, library | in progress ([[ossuary]]) |

## What Lich does better

Hermes is the richer system. These are the things Lich should protect as it grows: ^[raw/audits/2026-09-23-core-engine-audit.md]

- **A small, dependency-inverted loop.** The loop is about 245 lines and sees only `ChatFn` and `ToolRunner` (`src/agent/loop.ts:27-38@77bc148`). Hermes spreads its loop across about 35 `turn_*.py` phase files. Lich's loop can be read in one sitting and tested with fakes ([[lich-agent-loop]]).
- **Providers without SDKs.** Three small HTTP clients with injectable `fetch` and correct error classification. There are no vendor SDK upgrades to chase ([[lich-providers]]).
- **The security posture:**
  - realpath confinement
  - an SSRF guard that re-checks redirects
  - config-write denial
  - secret scrubbing for the terminal
  - the gatekeeper's test-gated commit
  - an MCP refuse-list

  ([[lich-tools-and-guardrails]])
- **Candid design docs.** The council reviews say what the guardrails do *not* protect against.
- **TypeScript and ESM.** The same code can run in Node, Bun, Electron and, once `core` is free of Node-only APIs, in browser games ([[subpaths-vs-packages]]).

## Lessons from Hermes' own history

- The Atropos RL environments were removed (`5af672c753`, 2026-05). Borrow the design from git history; don't take on the dependency.
- Hermes' `ui-tui` talks to a JSON-RPC backend (`tui_gateway/`), which confirms "one protocol for every surface" ([[0001-gateway-as-hub]]).

Related: [[game-transports]], [[roadmap-issues]].
