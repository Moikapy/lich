---
title: Decision models (typed, calibrated decisions)
created: 2026-10-02
updated: 2026-10-02
type: concept
tags: [providers, performance, research, games, security]
sources: [raw/audits/2026-10-02-decision-models-ollama-research.md, "#148"]
confidence: medium
---

# Decision models

**What they are.** A decision model does not chat. It takes state plus typed questions and returns a typed answer with a probability for every option, in one forward pass. The API shape comes from TypeSafe's Jev (`POST /v1/systemone`). Cloudflare's Clef / Clef-flash (Apache 2.0) and Ollama 0.35's local endpoint speak the same API. ^[raw/audits/2026-10-02-decision-models-ollama-research.md]

| Question type | Returns | Typical use |
|---|---|---|
| `noul` | probability of yes | gates, filters, guards |
| `choice` | one labelled option, per-option probabilities, confidence | routing, action pick, intent |
| `score` | position on an ordered rubric, plus distribution | urgency, risk, quality |

**Why Lich cares.** The [[tao-loop]] spends a full LLM call on every narrow decision. Decision models answer those in roughly 40-500 ms (Clef-flash fastest), locally or hosted, with a confidence value that tells the caller when to fall back to the LLM. That is the same latency problem [[action-terminal-mode]] attacks for game NPCs.

## Where it could fit

1. **Game action selection**, the first prototype in #148: a `choice` over the legal actions in [[game-bridge-example]], with a scripted or LLM fallback below a confidence threshold.
2. **Gateway triage** in [[lich-gateway]]: "should the agent answer this message?" before a run starts.
3. **Persona routing** in [[persona-orchestrator-example]], from message content.
4. **Tool-list narrowing** before an LLM turn, which cuts prompt tokens.
5. **A second-opinion guard** in a `before_tool_call` hook ([[lich-plugins-and-hooks]]).

## Rules of use

- **Optional plugin, never core.** This follows [[0008-idea-agnostic-extensible-harness]]: the loop stays model-agnostic and the decision client is an extension.
- **Always a fallback.** Low confidence, a timeout, or a compound or vague question goes to the LLM or a scripted action.
- **Add vetoes, never remove them.** Published work shows prompt injection shifts the probabilities and can move the answer. A decision-model verdict may block an action, but deterministic checks (URL guard, gatekeeper, MCP refusals) always still run. See [[embedded-safety-profile]].

## Getting the models

- **Ollama (local or ollama.com):** 0.35 adds `/v1/systemone` with `nimble` (9B) and `tev1` (4B, 0.8B). Lich's [[lich-providers]] Ollama client only speaks `/api/chat` (`src/providers/ollama.ts:155-158@e9bdd82`), so a separate small client is needed.
- **Cloudflare Workers AI:** `clef` (27B) and `clef-flash` (9B). Clef is not in the Ollama library; Ollaya runs it locally.

Numbers above come from search summaries, not the primary pages (blocked during research); re-verify before relying on them.
