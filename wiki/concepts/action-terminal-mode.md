---
title: Action-terminal mode (one LLM call per decision)
created: 2026-09-23
updated: 2026-09-23
type: concept
tags: [games, npc, core, performance]
sources: [raw/audits/2026-09-23-game-surface-audit.md, "#113"]
confidence: high
status_note: proposed, not implemented
---

# Action-terminal mode

**Problem.** In the standard [[tao-loop]], a successful tool call always goes back to the model for another turn (`src/agent/loop.ts:226-235@77bc148`). For a game NPC, the action *is* the answer. The second call ("I have ordered the goblins to flank") doubles latency and cost for nothing. ^[raw/audits/2026-09-23-game-surface-audit.md]

**Proposal** (#113 §2c item 5, not implemented):
- `stop_on_tools: string[]`, or `max_actions: n`: the loop returns as soon as a terminal tool succeeds.
- **Force the action:** `tool_choice: "required" | {name}`, or a JSON-schema response format. Small local models, including Ollama (the default in the examples), often skip optional tools.
- **`deadline_ms` + `fallback_action`:** if the deadline, budget or abort fires first, return a scripted action. The game never waits on the model.

**Effect:** one observation costs one LLM call, and the "drain even if the reply looks fine" workaround in `godot.md:143` is no longer needed.

**Provider mapping (sketch):**

| Provider | How to force the action |
|---|---|
| OpenAI | `tool_choice: {"type":"function","function":{"name":…}}` or `"required"` |
| Anthropic | `tool_choice: {"type":"tool","name":…}` or `{"type":"any"}` |
| Ollama | `format: <json schema>` (the tool-choice support depends on the model) |

Related: [[client-executed-tools]], [[lich-providers]], [[game-bridge-example]].
