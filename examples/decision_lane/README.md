# decision_lane

Prototype plugin for #148: before each LLM turn, ask a local **decision model** to pick every enemy's action for the current [game_bridge](../game_bridge/README.md) round. A decision model returns one labelled answer per question with a confidence, in one forward pass, instead of generating text. See the wiki page `wiki/concepts/decision-models.md` for background.

It needs the game_bridge plugin loaded too, and Ollama 0.35 or later with a decision model pulled:

```sh
ollama pull nimble        # or clef:27b (Ollama 0.35.1+)
```

```json
{
  "plugins": [
    "./examples/game_bridge/game_bridge.plugin.mjs",
    {
      "path": "./examples/decision_lane/decision_lane.plugin.mjs",
      "settings": { "mode": "shadow", "model": "nimble", "threshold": 0.75 }
    }
  ]
}
```

## How it works

1. The `before_llm_call` hook reads `.lich/game/state.json`. Without a usable snapshot (a round, at least one hero and one enemy) it does nothing.
2. It decides each round once per run. For every enemy it asks a `choice` question for the action (that enemy's `kit` abilities plus `attack`, `defend`, `flee`) and, when there is more than one hero, a `choice` question for the target.
3. It sends them to `POST {base_url}/v1/systemone` with a 2 s timeout. The request is checked against Ollama's limits before it is sent: 1-64 questions, 2-26 options per question, 64 KiB body.
4. It writes one line to `.lich/game/decisions.jsonl` per decision: mode, model, round, each enemy's picks with confidence, the lowest confidence, latency, the outcome (`shadow`, `acted` or `fallback`) and any fallback reason.

## Modes

| `mode` | Effect |
| --- | --- |
| `shadow` (default) | Only logs. Use it to compare the model's picks with the LLM's `enemy_actions` calls before trusting it. |
| `act` | When every answer's confidence is at least `threshold`, queues the round through game_bridge's own `enemy_actions` tool and adds a one-call note telling the LLM the round is handled. Otherwise the LLM turn runs as usual. |

In `act` mode the orders still go through game_bridge's validation and its meteor veto. A decision-model verdict can only add an order that those checks accept; it never bypasses them. A timeout, HTTP error, bad response, low confidence, veto or rejected order is logged as a fallback and the LLM decides the round. The hook never throws.

The LLM call itself still happens in `act` mode (hooks cannot skip it); the note keeps that turn short. Skipping the call outright would need a new hook result, which is out of scope for this prototype.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `mode` | `"shadow"` | `shadow` or `act`. |
| `base_url` | `"http://localhost:11434"` | System One endpoint root. |
| `model` | `"nimble"` | Decision model. Avoid `clef-flash` on Ollama 0.35.1 (ollama/ollama#18769); `clef:27b` works. |
| `threshold` | `0.75` | Minimum confidence for every answer before `act` queues orders. |
| `timeout_ms` | `2000` | Request timeout. |
| `log_file` | `"decisions.jsonl"` | File under `.lich/game/`. |
| `api_key_env` | none | Env var holding a Bearer key, for a hosted endpoint that needs one. |

## What leaves the machine

Each decision sends the battle snapshot (round, hero ids, enemy ids and kits) and the last user message, cut to 2000 characters, to `base_url`.

- **Local Ollama (default):** nothing leaves the machine. Ollama serves decision models locally only; it refuses cloud models on `/v1/systemone`.
- **Any other `base_url`:** that host receives the payload above, plus the key from `api_key_env` if set. Only local Ollama has been checked against this wire format.

## Benchmark

`bench.mjs` replays saved snapshots through one or more models and reports latency, and, at thresholds 0.6, 0.75 and 0.9, how often the lane would act (coverage) and how often it agrees with the LLM's orders:

```sh
node examples/decision_lane/bench.mjs cases.jsonl --models tev1:0.8b,nimble
```

Each line of `cases.jsonl` is `{"battle": <state.json snapshot>, "request": "...", "llm_actions": [<enemy_actions actions>]}`. Build it from a shadow run: pair each `state.json` with the `actions` from the matching `orders.jsonl` line the LLM wrote.
