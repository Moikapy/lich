---
title: Wiki index
type: index
updated: 2026-09-25
---

# Lich Wiki: Index

Start here. Read [SCHEMA.md](SCHEMA.md) for the conventions and [log.md](log.md) for recent activity. There are 39 pages.

**New to the codebase?** Read [[tao-loop]], then [[lich-agent-loop]], [[lich-vs-hermes]], [[0008-idea-agnostic-extensible-harness]] and [[roadmap-issues]].
**Working on the game features?** Read [[game-transports]], then [[action-terminal-mode]], [[client-executed-tools]] and [[embedded-safety-profile]].
**Working on content (video / Shorts / art)?** Same harness — a dogfood vertical under [[0008-idea-agnostic-extensible-harness]] (see also [[0007-content-as-fourth-goal]]).

## Entities: Lich subsystems

- [[lich-agent-loop]]: `run_conversation` + `Agent`. A dependency-injected TAO loop. Its P0 gaps are that events aren't scoped to a run, there is no streaming, it has global state, and each agent is heavyweight.
- [[lich-providers]]: openai_compat, anthropic and ollama clients without SDKs, plus failover. They have no streaming, `tool_choice` or cache_control, and ~150 lines of their helpers are duplicated.
- [[lich-tools-and-guardrails]]: builtins, an executor that never throws, and the wards. Known holes: `tools_enabled` doesn't restrict plugin tools, and `terminal` isn't sandboxed.
- [[lich-plugins-and-hooks]]: tool-call hooks with veto, and the gatekeeper's single gated `git_commit`. There are no prompt-level hooks, and hooks fail open.
- [[lich-sessions]]: JSONL phylacteries used as combat logs. There is no search, and gateway files are supersets of each other.
- [[lich-mcp]]: an MCP client and catalog. Redot is a real entry and Godot has none. The code is spread over 21 micro-files.
- [[lich-gateway]]: familiars routed into one shared Agent. The per-chat bus and read-only defaults make it a good hub.
- [[lich-serve]]: WebSocket JSON-RPC for Ossuary, fully merged (#99–#103). It still has one global queue, one Agent per process, and no event envelope.
- [[ossuary]]: the Electron + Dockview desktop app (#79 closed after #123). It renders from serve events; the event envelope is still #114 item 2.

## Entities: the ecosystem and games

- [[hermes-agent]]: the Python agent that inspired Lich, with local paths and the mechanisms worth studying. Its RL environments were removed in `5af672c753`.
- [[godot-and-redot]]: the game→Lich direction (webhook plus file bus) and the Lich→editor direction (Redot MCP). `WebSocketPeer` is the path to a GDScript SDK.
- [[game-bridge-example]]: the file-bus enemy commander. It's racy, needs 2 LLM calls per decision, and will retire once client tools exist.
- [[persona-orchestrator-example]]: one Agent per NPC persona, which collapses to ~20 lines once Profiles and Sessions exist.
- [[roadmap-issues]]: what #113, #114, #79 (closed) and #46/#47 (closed) are each for; north star + verticals + six phases. Status lives on the kanban, not here.

## Concepts

- [[tao-loop]]: the think-act-observe loop and the invariants every harness has to keep.
- [[action-terminal-mode]]: one LLM call per decision, using `stop_on_tools`, `tool_choice` and deadlines with a fallback action.
- [[client-executed-tools]]: the game owns its tools through `tool.invoke`/`tool.result`, which replaces the file bus.
- [[event-envelope]]: events scoped by run and session, JSON-safe, with a per-run `on_event`. Landed in #134 (0.10.0); gateway adapter adoption still #114.
- [[runtime-profile-session]]: one Runtime per process, cheap Profiles, and a Session per NPC.
- [[prompt-cache-tiers]]: a byte-stable system prompt built in tiers, plus `cache_control` breakpoints (the Hermes approach).
- [[memory-vs-skills]]: declarative memory vs procedural skills, loaded by progressive disclosure. Lich has neither yet.
- [[npc-memory-namespaces]]: private `npc:<id>` memory and shared `world` memory, with identity carried in `ToolContext`.
- [[streaming-deltas]]: `text_delta` events for dialogue, TTS and the chat pane. Lich has no streaming today.
- [[embedded-safety-profile]]: the game-safe preset: no builtins, hooks that fail closed, untrusted player text, and budgets.
- [[llm-wiki-pattern]]: Karpathy's compiled-knowledge wiki, which this wiki uses. It also doubles as a design for Lich's memory.

## Comparisons

- [[lich-vs-hermes]]: a feature table with a port/adapt/skip call for each feature, plus what Lich does better.
- [[game-transports]]: library vs webhook vs file bus vs serve vs stdio, with a verdict for each use case.
- [[subpaths-vs-packages]]: one package with subpath exports vs separate npm packages, and when to revisit.

## Decisions

- [[0001-gateway-as-hub]] (proposed): build around the gateway; serve becomes its interactive adapter.
- [[0002-serve-pr-merge-path]] (superseded by events): the merge order fired — #101/#102 merged without the SessionManager/envelope steps; remaining work is #114 item 2.
- [[0003-subpath-exports-over-packages]] (proposed): one package, `exports` subpaths, `ink`/`react` as optional peers, layers enforced by lint.
- [[0004-dry-policy]] (proposed): remove real duplication, merge over-split modules, and don't DRY the wire mapping.
- [[0005-kanban-and-single-issue-workflow]] (accepted): the Lich Roadmap project, one issue per batch of changes, and agents advancing cards only on facts.
- [[0006-in-repo-llm-wiki]] (accepted): this wiki, kept in the repo, with guardrails.
- [[0007-content-as-fourth-goal]] (superseded): content as an explicit vertical — framing folded into [[0008-idea-agnostic-extensible-harness]].
- [[0008-idea-agnostic-extensible-harness]] (accepted): idea-agnostic harness; win on plugins, tools, and user control; verticals are dogfood.

## Queries

- [[build-everything-around-the-gateway]]: could everything be built around the gateway? Yes, as Hermes does, with trade-offs.
- [[llm-wiki-vs-docs]]: what an LLM wiki adds beyond the docs.
- [[project-vs-user-skill]]: should the kanban skill be project-level or user-level? Project-level.
