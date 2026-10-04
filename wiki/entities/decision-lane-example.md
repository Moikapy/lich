---
title: decision_lane example (decision model for game_bridge rounds)
created: 2026-10-04
updated: 2026-10-04
type: entity
tags: [games, npc, plugins, providers]
sources: [raw/audits/2026-10-03-ollama-systemone-clef.md, "#148", "#159"]
confidence: medium
---

# decision_lane example

`examples/decision_lane/*` (#159, `cbdf58e`) is the first prototype of [[decision-models]] in Lich. A `before_llm_call` hook asks a local Ollama decision model to pick each enemy's action for the current [[game-bridge-example]] round. It is not shipped in the npm package.

## How it works

- **Plugin-owned client.** `systemone.mjs` posts to `{base_url}/v1/systemone` with a 2 s timeout and checks Ollama's limits before sending: 1-64 questions, 2-26 criteria, 64 KiB body (`examples/decision_lane/systemone.mjs:8,30@cbdf58e`). Core providers are untouched, as [[0008-idea-agnostic-extensible-harness]] asks.
- **Questions.** One `choice` per enemy for its action (kit plus `attack`/`defend`/`flee`) and one for its target when there is more than one hero (`examples/decision_lane/round.mjs:40@cbdf58e`). An answer outside the offered criteria counts as confidence 0 (`round.mjs:96@cbdf58e`).
- **Modes.** `shadow` (default) only logs. `act` queues orders when every answer clears `threshold`, and returns a one-call note ([[lich-plugins-and-hooks]]). It decides each round once per run (`examples/decision_lane/decision_lane.plugin.mjs:31-61@cbdf58e`).
- **Guard rule.** Act-mode orders go through game_bridge's own `meteor_veto` and `enemy_actions` validation (`decision_lane.plugin.mjs:77,81@cbdf58e`). The verdict can add an order those checks accept; it cannot bypass them. Low confidence, a non-numeric threshold, a veto, a rejected order or any request failure falls back to the LLM, and the hook never throws.
- **Log.** One JSONL line per decision in `.lich/game/decisions.jsonl`: picks, confidences, latency, outcome, fallback reason. The file name must be bare, so it stays under `.lich/game` (`decision_lane.plugin.mjs:104@cbdf58e`).
- **Egress.** With the default local Ollama nothing leaves the machine; Ollama serves decision models locally only ^[raw/audits/2026-10-03-ollama-systemone-clef.md]. Another `base_url` receives the snapshot and the last user message (capped at 2000 chars), plus `Authorization: Bearer <key>` when `api_key_env` is set (`decision_lane.plugin.mjs:47@cbdf58e`).

## Limits

- **The LLM call still happens in act mode.** Hooks cannot skip it, so act mode saves the decision, not the call; the note keeps that turn short. Skipping it needs a new hook result. This is the same latency problem [[action-terminal-mode]] targets.
- **No measured result yet.** `bench.mjs` replays saved snapshots and reports latency, coverage and agreement with the LLM at thresholds 0.6 / 0.75 / 0.9. #148 stays open until a shadow run and bench numbers (`tev1:0.8b`, `nimble`) are written up here as keep or drop.
- **Model choice.** `clef-flash` is broken on `/v1/systemone` in Ollama 0.35.1 (ollama/ollama#18769); default is `nimble`, and `clef:27b` works.
