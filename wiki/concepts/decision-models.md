---
title: Decision models (typed, calibrated decisions)
created: 2026-10-02
updated: 2026-10-04
type: concept
tags: [providers, performance, research, games, security]
sources: [raw/audits/2026-10-02-decision-models-ollama-research.md, raw/audits/2026-10-03-ollama-systemone-clef.md, raw/audits/2026-10-02-hermes-models-memory-decisions.md, "#148", "#149", "#159"]
confidence: medium
---

# Decision models

**What they are.** A decision model does not chat. It takes state plus typed questions and returns a typed answer with a probability for every option, in one forward pass. The API shape comes from TypeSafe's Jev (`POST /v1/systemone`). Cloudflare's Clef / Clef-flash (Apache 2.0) and Ollama's local `/v1/systemone` endpoint (0.35+) serve the same question types; exact Jev wire compatibility is unverified. ^[raw/audits/2026-10-02-decision-models-ollama-research.md] ^[raw/audits/2026-10-03-ollama-systemone-clef.md]

| Question type | Returns | Typical use |
|---|---|---|
| `noul` | probability of yes | gates, filters, guards |
| `choice` | one labelled option, per-option probabilities, confidence | routing, action pick, intent (Ollama: 2-26 options) |
| `score` | position on an ordered rubric, plus distribution | urgency, risk, quality |

**Why Lich cares.** The [[tao-loop]] spends a full LLM call on every narrow decision. Decision models answer those in roughly 40-500 ms (Clef-flash fastest), locally or hosted, with a confidence value that tells the caller when to fall back to the LLM. That is the same latency problem [[action-terminal-mode]] attacks for game NPCs.

## Where it could fit

1. **Game action selection**, prototyped as [[decision-lane-example]] (#159): a `choice` per enemy action and target in [[game-bridge-example]], shadow by default, falling back to the LLM below a confidence threshold. Not yet measured.
2. **Gateway triage** in [[lich-gateway]]: "should the agent answer this message?" before a run starts.
3. **Persona routing** in [[persona-orchestrator-example]], from message content.
4. **Tool-list narrowing** before an LLM turn, which cuts prompt tokens.
5. **A second-opinion guard** in a `before_tool_call` hook ([[lich-plugins-and-hooks]]).

## How Hermes does it

[[hermes-agent]] core has no decision-model support. Fifteen dedicated community plugins (plus four with Jev backends) add it on generic host features: per-plugin settings, host-owned model access, and hooks before tool and LLM calls. They route skills (`pre_llm_call`), gate tools (`pre_tool_call`, shadow by default), review approvals (failures escalate), pick per-turn model and effort (request middleware), and skip idle cron runs. ^[raw/audits/2026-10-02-hermes-models-memory-decisions.md]

## Rules of use

- **Optional plugin, never core.** This follows [[0008-idea-agnostic-extensible-harness]]: the loop stays model-agnostic and the decision client is an extension.
- **Shadow mode first,** with one log line per decision (question, answer, confidence, latency, fallback reason), as the Hermes plugins do.
- **Always a fallback.** Low confidence, a timeout, or a compound or vague question goes to the LLM or a scripted action.
- **Add vetoes, never remove them.** Published work shows prompt injection shifts the probabilities and can move the answer. A decision-model verdict may block an action, but deterministic checks (URL guard, gatekeeper, MCP refusals) always still run. See [[embedded-safety-profile]].

## Getting the models

- **Ollama, local only.** `/v1/systemone` shipped in 0.35.0 with `nimble` and `tev1`; 0.35.1 adds Cloudflare's `clef` (27B) and `clef-flash` (9B), which also take images. The server refuses cloud models on this endpoint, so ollama.com hosting does not apply. Limits: 1-64 questions, 2-26 criteria, 64 KiB body without images. `confidence` is 1 minus normalised entropy, not a calibration guarantee. `clef-flash` is broken on `/v1/systemone` in 0.35.1 (ollama/ollama#18769); prefer `clef:27b` or `nimble` until it is fixed. ^[raw/audits/2026-10-03-ollama-systemone-clef.md]
- **Cloudflare Workers AI:** hosted `clef` and `clef-flash`.
- **Lich side.** The [[lich-providers]] Ollama client only builds `/api/chat` URLs (`src/providers/ollama.ts:155-158@e9bdd82`), and a chat call would lose the probabilities. The decision client therefore lives in the plugin (#148), as in Hermes. Since #157 a plugin entry carries its endpoint and thresholds in `settings`, can call a granted host role through `ctx.models.chat`, and can add a one-call note through `before_llm_call` ([[lich-plugins-and-hooks]]).

Model sizes and latency figures still come from search summaries; re-verify before relying on them.
