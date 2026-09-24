---
title: Lich agent loop (run_conversation + Agent)
created: 2026-09-23
updated: 2026-09-23
type: entity
tags: [core, events, context]
sources: [raw/audits/2026-09-23-core-engine-audit.md]
confidence: high
---

# Lich agent loop

This is the heart of Lich. `run_conversation` (`src/agent/loop.ts@77bc148`, about 245 lines) implements the [[tao-loop]]. `Agent` (`src/agent/agent.ts`) is the composition root that wires it to real providers and tools.

## Shape

- **Dependency-inverted.** The loop sees only `ChatFn`, `ToolRunner`, `definitions()` and an optional emitter (`loop.ts:27-38@77bc148`). It never imports a router or executor, so it can be tested with fakes, and compression reuses the same `ChatFn` (which means compression also gets provider failover).
- **Each turn:**
  1. abort check
  2. `compress_if_needed`: chars/4 estimate ≥ 0.8 × budget; keeps the last 8 messages; the summary is injected as a user message
  3. LLM call through `chat_with_failover` (see [[lich-providers]])
  4. push the assistant message
  5. no tool calls → `final`; otherwise run the tool calls **sequentially** (`loop.ts:110-121@77bc148`)
- **Stop reasons:** `final`, `budget` (default `max_turns` 25), `aborted`. Other provider errors are thrown.
- **Events:** 11 synchronous event types (`events.ts:12-24@77bc148`) with **no run or session id** and no token deltas. See [[event-envelope]] and [[streaming-deltas]].
- **System prompt:** one static string, `config.system_prompt ?? DEFAULT_AGENT_SYSTEM_PROMPT`. Memory and skills are not injected; see [[memory-vs-skills]].

## Known gaps (still open on v0.9.0)

The P0 gaps block many concurrent NPCs and real-time UIs:
- events are not scoped to a run
- no streaming
- process-global state (docs root, log level, Ollama id counter)
- each `Agent` builds its own router, tools, plugins and MCP connections

The P1 gaps:
- no parallel tools
- no `tool_choice` / structured output
- string-only content (no vision)
- no prompt caching
- no validation of tool arguments
- no hooks at the prompt level

Also: tools requested on the last turn still run, and one-shot/chat install no SIGINT handler. ^[raw/audits/2026-09-23-core-engine-audit.md]

**Fixed on origin v0.9.0:**
- `turn_end` fires on every turn (A-10)
- compression usage is counted
- plugin hook state is per run (AsyncLocalStorage)
- Anthropic drops truncated tool calls when `finish_reason` is length

## Proposed direction

Split `Agent` into Runtime, Profile and Session ([[runtime-profile-session]]). Add [[action-terminal-mode]], `tool_choice`, parallel safe tools and the [[event-envelope]]. See #113 §2c.

Related: [[lich-tools-and-guardrails]], [[lich-plugins-and-hooks]], [[lich-vs-hermes]].
