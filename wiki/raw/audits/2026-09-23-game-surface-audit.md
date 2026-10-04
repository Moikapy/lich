---
source_url: session:2026-09-23 architecture audit subagent report (see #113)
ingested: 2026-09-23
sha256: f3ca51300a6a649376b8ace6c9db09f4ba9efef4c7a802cff61cbd3ff1156d3a
---
# Lich game-readiness audit (2026-09-23)

Read-only audit by a subagent during the architecture audit session (see #113). It covers three goals: (A) coding games, (B) playing games, (C) being embedded in games and simulations.

**Version note:** local `~/code/lich` is on `main` at v0.8.0 (`77bc148`), 56 commits behind `origin/main` (v0.9.0). Line references are local unless marked origin. Two v0.9.0 changes matter here:
- Plugin hook `state` is now per-run through AsyncLocalStorage. Locally it is still a per-plugin WeakMap replaced on every new run (`src/plugins/hooks.ts:31,126`), so concurrent runs clobber each other's state.
- The webhook now caps request bodies at 1 MB (413 above that).

The serve worktrees (#80–#94) branch from v0.9.0.

## 1. What exists today

### A. Helping code games (editor side)
- Generic MCP client (`mcp_servers`, stdio, or HTTP on loopback only) with a catalog in `optional-mcps/`.
  - `optional-mcps/redot/manifest.json` runs `redot --headless --mcp-server --path <p>`, drops `execute`, and exposes `scene_action`, `resource_action`, `code_intel`, `project_config` and `game_control` (`docs/user-guide/redot.md:79-87`).
  - `optional-mcps/godot/manifest.json` is deliberately `transport: "none"`, because Godot has no official MCP.
- Everything else goes through the builtin file, terminal and grep tools.
- Missing: Unity, Unreal, Bevy and GameMaker entries; engine docs retrieval beyond `docs_read`/`docs_search`; any engine-aware "run the game headless and read logs/test results" tool.

### B. Playing games
- Nothing: no screen capture, input injection, emulator/gym environment, or vision.
- `Message` content is text-only (`src/providers/types.ts:21-45`).
- The only view of a running game is Redot's `game_control` (screenshots and clicks). It is an editor tool, and its screenshot can't reach the model as an image.

### C. Embedded in games (NPC brains, game masters, sim agents)

**Transport today:** HTTP `POST /message` with `{text, chat_id, user_id}`, returning `{reply, usage:null}` (`src/gateway/webhook.ts:80-98`).
- One Agent serves every conversation, so they all share the same system prompt and tools (`src/gateway/runner.ts:16-21`).
- Runs for one `platform:chat_id` are serialized; different ids run concurrently (`src/gateway/bus.ts:51-66`).
- History is in memory only: 40 messages and 200 conversations (`bus.ts:27-28`).
- The webhook forces `platform` to `"webhook"` (`webhook.ts:93`) and always returns `usage: null` (`:97`). A failed run still returns HTTP 200 with an `agent error:` string.

**Auth:** optional `x-lich-token`, required for a non-loopback bind (`webhook.ts:163-175`). The gateway defaults to read-only tools (`src/gateway/access.ts:10-18`).

**Actions:** `examples/game_bridge` gives the model an `enemy_actions` tool.
- It appends JSONL to `.lich/game/orders.jsonl`, which Godot polls, applies and truncates.
- `state.json` is compared on `round` only (`enemy_actions.mjs:22-32`, `snapshot.mjs`).
- Durable memory is an append-only `memory.jsonl` whose reads are capped at 20 notes (`dungeon_memory.mjs`, `bridge_paths.mjs:7`).
- A hardcoded `before_tool_call` veto blocks meteor before round 3 (`meteor_veto.mjs`).

**Personas:** `examples/persona_orchestrator` creates one Agent per persona, keyed `chat_id = npc:<persona>:<run>` (`personas.ts:42-53`), and returns `{reply, usage}` over loopback on port 8090 (`server.ts:105-113`).

**Replay:** the session JSONL is the replay log. There is no seed/RNG replay (`docs/user-guide/games.md:5`).

**Latency guidance:** "seconds, not frames… once per combat round" (`docs/user-guide/godot.md:16`).

**Tests:** `test/game_bridge.test.ts` covers file effects, the veto and dist loading. `test/persona_orchestrator.test.ts` covers the per-persona prompt, serialization and budget. All model calls are mocked.

## 2. Gaps

### Across all use cases

**No streaming.**
- Providers make whole-response calls. Ollama sends `stream:false` (`src/providers/ollama.ts:32,228`; same on origin).
- Serve's "streaming" is per-turn `AgentEvent`, not tokens.
- Dialogue NPCs need token deltas for text reveal and TTS.

**No structured output.**
- `ChatOptions` has no `tool_choice`, `response_format` or grammar (`types.ts:67-73`).
- Small local models (Ollama is the default in `run.ts:17`) often skip the tool entirely. `godot.md:143` has to tell developers to "drain even when reply looks fine — the model may never have called the tool, or … twice".

**Every action costs at least two LLM calls.**
- After a tool runs, the loop always goes back to the model (`src/agent/loop.ts:226-235`).
- There is no "terminal tool", "stop after action" or "max one action" mode. For a game, the action *is* the answer, so this doubles latency and cost.

**Tools don't know which NPC or conversation they serve.**
- `ToolContext` is only `{work_dir, env, signal}` (`src/tools/types.ts:9-13`; same on origin).
- All NPCs write to the same `orders.jsonl` and `memory.jsonl`, and there is no per-NPC or per-player memory unless ids are encoded in the tool arguments.

**Tool calls run one at a time** (`loop.ts:110-121`). That's fine for correctness but slow for NPCs that do several reads.

### A (coding games)
- Only Redot has a real catalog entry.
- Missing:
  - engine-aware tools: headless build/run, GUT/GdUnit test runners, Unreal Automation, engine log parsing
  - asset pipelines and a scene-diff view
  - screenshots fed back as images for visual QA (blocked by text-only messages)

### B (playing games)
Everything is missing:
- a perception→action tick loop
- screen capture, image observations and frame diffs
- input injection (keyboard, mouse, gamepad)
- Gym, PettingZoo and emulator adapters (retro, mGBA, PyBoy)
- frame-skip / act-every-N-ticks scheduling
- an action-space schema (discrete or continuous)
- episode, reward and done semantics
- an eval harness or benchmark (win rate, steps, tokens per episode)
- deterministic replay (pinned seed and temperature, recorded observations for re-simulation)

### C (embedded)

**Transport:**
- There is no push from Lich to the game, so the game has to poll files.
- The file bus is racy by design: a line can be lost mid-truncate, and duplicates are possible (`examples/game_bridge/README.md:26`).

**Game state:**
- Observations are free-text digests (`godot.md:78`).
- There are no typed snapshots or diffs, no world-state query tools served by the game, and no event injection ("player entered room").

**Concurrency:**
- One gateway Agent means one persona per process.
- The orchestrator example is copy-paste, not a library API.
- Nothing supports shared world memory alongside private NPC memory, or retrieval beyond the last 20 notes.
- There is no batching or scheduling of many NPCs (priorities, per-frame budgets, dropping stale requests).
- History is lost on restart (`godot.md:62`).

**Cost and latency controls:**
- Only `max_turns`, `max_tokens` and `context_budget_tokens` exist.
- Missing: a per-call deadline from the game; token or cost budgets per NPC; rate limits per player or session; a response cache; a "fallback action on timeout" contract; routing to a small model for chatter vs a large one for the game master.
- `usage: null` on the webhook blocks accounting.

**Safety for shipping:**
- `git_commit` from the gatekeeper is always registered, even with `tools_enabled: []` (persona README:22).
- Plugins run in-process with full privileges (`godot.md:155`).
- A hook that throws is skipped, so a veto that crashes lets the call through (fail-open, `docs/user-guide/plugins.md:104`).
- There is no "sandboxed game profile" preset: no fs/terminal/network, output length and profanity filters, and prompt-injection protection for player-typed text.

**Engine clients:** none. There is only a GDScript HTTP sketch (`godot.md:82-112`); nothing for C#, Unity, Unreal or C++ for either the webhook or serve.

**Stale docs (still wrong on origin):** `godot.md:33` and `:151` say the webhook binds `0.0.0.0`, and so does `examples/persona_orchestrator/README.md:42`. The code defaults to `127.0.0.1` (`webhook.ts:13`), and `gateway.md:34,172` is correct.

## 3. Is serve (JSON-RPC over WebSocket) the right embedding transport?

**What serve is today** (`~/code/lich-wt-issue-84/src/serve/`, docs `wt-94/docs/architecture/serve.md`):
- Seven locked methods: `health`, `session.create/list/clear/resume` and `prompt.submit/abort` (`protocol.ts:9-17`).
- `event` notifications forward `AgentEvent` unchanged (`protocol.ts:133-137`).
- Loopback only (`server.ts:250-256`).
- A random token printed on the boot stdout line (`server.ts:81,258-266`), passed as a header or `?token=`.
- Batch requests are rejected (`rpc.ts:26-27`).
- #79 scopes serve as the desktop/Ossuary control surface ("Do not build panels on webhook") and doesn't mention games.

**Verdict:** WebSocket JSON-RPC is the right *out-of-process* transport for games.
- Godot has `WebSocketPeer`, and Unity and Unreal have WebSocket modules.
- It is bidirectional, which fixes the file-polling and push problem.
- It beats per-request HTTP (push, cancel, interleave).
- It beats stdio for engines, since spawning and piping children is awkward on consoles and mobile. stdio remains a good extra mode for Python tools and gym harnesses.
- In-process library use is realistic only for JS/TS hosts (web games, Node sim servers).

**What serve is missing for games:**
- **Concurrency:** one global run queue across *all* sessions (`prompts.ts:193-209` in wt-84, `run_tail`), because `agent.events` is process-wide. Ten NPCs take 10× the latency. Events need per-run scoping (the per-run emitter exists at `src/agent/agent.ts:150-152`), and runs should run concurrently.
- **Per-session config:** one Agent for every session, so there is no per-session `system_prompt`, `tools_enabled`, model, budgets or temperature. `session.create` takes only `{label, source}` (`protocol.ts:70-75`).
- **Client-executed tools:** the game needs to register tools that the client executes, through a server→client request like `tool.invoke` / `tool.result` with a deadline. This replaces `orders.jsonl` and gives typed actions plus world-state queries.
- **Structured observations:** `prompt.submit` takes only `{session_id, text}` (`protocol.ts:110-113`). It needs `observation` (JSON, image refs/binary), `deadline_ms`, `seed`, `tool_choice`, and `max_actions:1` / `stop_on_tool`.
- **Token-delta notifications** and smaller event payloads: `llm_end` ships the whole `ChatResult` every turn.
- **Session lifecycle and isolation:**
  - session bags are never evicted (`sessions.ts:17-47`)
  - `session.clear` resets history but a session can't be deleted
  - any client can drive any `session_id`
  - no namespaces, per-session memory store, or persisted game-side context
- **Safety:** `lich serve` uses the CLI config, where `tools_enabled` defaults to `"all"` (`src/agent/config.ts:89`). There is no gateway-style safe default, so an embedded client gets `terminal`/`write_file` unless configured otherwise.
- **Deployment:**
  - loopback only with no TLS, so a dedicated server or LAN game master needs a proxy
  - the token is discoverable only from stdout (fine when the game spawns Lich)
  - no protocol versioning or capability negotiation beyond the `health` version string

## 4. Recommendations, ranked by impact

1. **Make serve concurrent with per-session agent profiles.** Scope events per run and use a queue per session instead of one global queue. `session.create` accepts a `profile` (persona, `system_prompt`, tools, model, budgets). Add `session.delete` and a TTL. This unlocks C and is a prerequisite for B.
2. **Client-executed tools in the protocol.** The client declares tools in `session.create`, and the server sends `tool.invoke` requests that the client answers. Add an **action-terminal mode** (`stop_on_tool`, `max_actions`) so one observation costs one LLM call. This replaces `orders.jsonl`, fixing the race and the double calls.
3. **Structured output at the provider layer:** `tool_choice` (required or named), a JSON-schema `format` for Ollama, OpenAI and Anthropic, and a `fallback_action` returned on budget, timeout or deadline. This matters most for small local models.
4. **Streaming:** `stream:true` in the providers, with `text_delta` events forwarded over serve, for dialogue and TTS.
5. **A "game-safe" preset** (`profile: "embedded"`):
   - no builtins, no `git_commit`, no network
   - hooks that fail closed
   - output caps
   - player text tagged as untrusted
   - per-session rate and token budgets, returned as real `usage` (also fix `usage:null` on the webhook)
6. **Session/NPC identity in `ToolContext`/`HookContext`** (`session_id`, `label`, profile), and a memory module with private per-NPC namespaces plus a shared world namespace, persisted and retrievable (recency + keyword/embedding).
7. **Engine SDKs for serve:** a GDScript addon first (autoload + signals, working for Godot and Redot), then C# for Unity and Godot .NET, then an Unreal C++ plugin. Generate them from `protocol.ts` via a JSON Schema export, and ship a sample project that replaces the file bus.
8. **Play/eval harness for B:**
   - a `lich env` adapter interface (`reset` / `step(action) → obs, reward, done`) with a Python stdio bridge for Gymnasium and retro emulators
   - image observations (requires multimodal `Message`)
   - frame-skip scheduling
   - pinned seed and temperature plus recorded observations for deterministic replay
   - a benchmark runner reporting win rate, steps, tokens and latency percentiles
9. **Editor coding (A):**
   - catalog entries or recipes for Unity, Unreal and community Godot MCPs (opt-in, pinned by path)
   - tools for headless builds and tests, plus engine log parsing
   - screenshot-to-vision for visual QA
10. **Docs:** fix the `0.0.0.0` claims (`godot.md:33,151`, `persona_orchestrator/README.md:42`); add a latency budget table (local 1–3B vs cloud; time to first token vs full reply); note that serve is the intended game transport once items 1 and 2 land.
