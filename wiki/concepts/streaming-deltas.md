---
title: Streaming deltas
created: 2026-09-23
updated: 2026-09-23
type: concept
tags: [providers, events, npc, performance]
sources: [raw/audits/2026-09-23-core-engine-audit.md, raw/audits/2026-09-23-game-surface-audit.md]
confidence: high
---

# Streaming deltas

**Today:** there is no token streaming anywhere in Lich (still true on v0.9.0).
- Ollama hard-codes `stream:false`.
- The Anthropic and OpenAI clients read a single JSON body.
- Serve's "streaming" is per-turn `AgentEvent`s, not tokens.

**Who needs it:**
- NPC dialogue: text revealed as it arrives, and text-to-speech
- the [[ossuary]] chat pane
- any interface where the time to the first token matters more than the time to the full reply

**Proposal** (#113 §2c item 2):
- `LLMProvider.stream()` that parses SSE (OpenAI, Anthropic) and NDJSON (Ollama).
- New events in the [[event-envelope]]: `text_delta`, `thinking_delta`, `tool_call_delta`.
- The non-streaming `chat()` becomes a fold over the stream, so there is only one code path.
- Serve forwards `text_delta` as notifications ([[lich-serve]]).

**Caution:** a tool call streamed as deltas can't be acted on until it is complete. For games, stream the *speech* and apply the *action* once the call has finished ([[action-terminal-mode]]).

Related: [[lich-providers]].
