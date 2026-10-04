---
source_url: https://github.com/Moikapy/lich/issues/113
ingested: 2026-09-23
sha256: b71755fe926aa284fa54a719b006853064ac4e610390c94bb234139861f581f5
---
# #113 Architecture & gap audit: games (code/play/embed), Hermes parity, reorganization + docs

## Summary

This is the architecture and gap audit of Lich against three goals:

- **(A) Code games:** help build games in Godot, Redot, Unity, Unreal and similar engines.
- **(B) Play games:** act as a player in games, emulators and gym environments.
- **(C) Live inside games:** run NPC brains, game masters and simulation agents.

It also compares Lich with Hermes, using the Hermes checkout at `~/.hermes/hermes-agent`. The Hermes docs live in `website/docs/developer-guide/` and the per-area `AGENTS.md` files.

Per the owner's request, **every proposed change is collected in this one issue** so nothing lands piecemeal. It can be split into child issues later. Two documentation drafts are included at the bottom:

- a user guide for choosing a game integration path
- an educational "how an agent harness like Lich works" page

**Baseline:**
- The audit read local `main` at v0.8.0 (`77bc148`).
- Every gap below was then checked against **origin/main v0.9.0 (`bad1243`)**, which is 56 commits ahead.
- Items already fixed on origin are marked ✅.
- Line references are from v0.8.0.

**Health:**
- 396/396 tests pass and `tsc --noEmit` is clean.
- The loop is small, dependency-injected (`ChatFn` / `ToolRunner`) and well tested.
- The security posture is serious: realpath confinement, an SSRF guard, config-write denial, the gatekeeper, and the MCP refuse-list.
- The foundations are good. What's missing is capability for real-time, multi-agent and multimodal use, not correctness.

---

## 1. Verdict: what's structurally missing

Lich is a solid **request/response, single-persona, text-only, sequential** TAO loop. That shape fits "a coding agent in a terminal". It does not fit games, which need:

| Need | Why games need it | Lich today (verified on origin v0.9.0) |
|---|---|---|
| Token streaming | NPC dialogue, TTS, a responsive chat pane | ❌ No streaming. Ollama hard-codes `stream:false`, and the Anthropic and OpenAI clients read one JSON body. |
| Structured actions / `tool_choice` | Small local models often skip the tool. `godot.md:143` has to tell devs to "drain even when reply looks fine". | ❌ `ChatOptions` = `{temperature, max_tokens, signal, think}` |
| "The action *is* the answer" | Each tool call forces a second LLM round, doubling latency and cost per NPC decision | ❌ No `stop_on_tool` / terminal-tool mode (`loop.ts:226-235`) |
| Many concurrent agents | Ten NPCs should not queue behind each other | ⚠️ Runs can overlap, but `agent.events` is shared and events carry **no run/session id**. Serve (#83) serializes *all* sessions on one global queue (`prompts.ts` `run_tail`). |
| Per-agent identity in tools | NPC-private memory, per-NPC order channels | ❌ `ToolContext = {work_dir, env, signal}` |
| Vision / images | Playing games from pixels, visual QA of scenes | ❌ `Message.content` is `string` everywhere |
| Persistent memory and skills in the prompt | Characters that remember; an agent that learns a codebase | ❌ `MEMORY.md` is a README convention only. Skills are reachable only via `docs_search`. |
| Game-safe profile | Shipping inside a game build | ❌ `lich serve` inherits CLI `tools_enabled: "all"` (terminal, write_file). `git_commit` bypasses `tools_enabled`. Hooks fail open. |

---

## 2. Proposed architecture reorganization

### 2a. Layering (package boundaries)

Today core modules import surfaces:
- `agent/config.ts:6-8` imports `gateway/access`, `gateway/token_env` and `mcp/mcp_pin`.
- `tools/builtin/terminal.ts` imports `gateway/token_env`.
- `session/recorder.ts` imports `agent/loop` (upward).
- `ink` and `react` are hard runtime dependencies of the *library*, and there is no `exports` map.

Proposed:

```
packages/
  core/      @moikapy/lich-core   — Message/Content types, run_conversation, events,
                                     compressor, Tool/Provider interfaces. No fs, no Node-only APIs
                                     → can run in a browser/web game, Deno, Bun, Electron renderer.
  runtime/   @moikapy/lich        — providers (+ shared providers/http.ts), executor, registry,
                                     builtin tools, plugins, MCP, sessions, memory, config.
  serve/     (in runtime or own)  — JSON-RPC/WS server; the ONE protocol every UI & game uses.
  cli/       @moikapy/lich-cli    — cli, tui (ink/react live here only), setup wizard.
  gateway/                        — messaging familiars; owns its own config slice.
apps/ossuary/                     — Electron desktop (already on origin), a serve client.
sdk/godot, sdk/unity, sdk/unreal  — engine clients generated from serve's protocol schema.
```

Rules:
1. **Every surface (TUI, gateway, Ossuary, game SDKs) talks to the runtime through the same API.** In-process that API is `Agent` + `Session`; out of process it is `serve`. The gateway and TUI should eventually become serve clients (or thin in-process adapters) so behaviour doesn't drift between surfaces. Hermes learned this the hard way: its `ui-tui/` talks to the `tui_gateway/` JSON-RPC backend.
2. **Surfaces register their own config schema slices.** The gateway allowlist does not belong in `AgentConfig`.
3. **Collapse the flat root files:** `cli_*.ts` ×7 go into `cli/`; drop the `gateway.ts` and `tui.tsx` shims; drop the redundant `mcp_` prefix inside `mcp/`.

### 2b. Split `Agent` into Runtime + Profile + Session

Today each `Agent` builds its own router, all builtins, plugins and MCP children, and a run cannot override prompt, tools or model. That makes "100 NPCs" mean 100 heavy agents. Proposed:

- **`Runtime`** (one per process): providers/router, tool registry, MCP connections, plugin host, session store.
- **`Profile`** (cheap, data-only): `{ system_prompt, toolsets, model/provider route, budgets, temperature, memory_namespace, safety: "dev" | "embedded" }`. Examples: "goblin_shaman", "game_master", "godot_coder".
- **`Session`** (per conversation / NPC instance): history, memory handle, run queue, event stream scoped by `session_id` + `run_id`.

`serve`'s `session.create` then takes `{profile | inline profile, label}`, which resolves the "one Agent for every session" limitation.

### 2c. Core loop changes (in order)

1. **Event envelope:** `{run_id, session_id, seq, ts, type, …}`. Make `error` JSON-safe (`{kind, message}`), add `run_start`/`run_end`, and add a per-run `on_event` in `AgentRunOptions`. Stop emitting aborts as `error`.
2. **Streaming:** add `LLMProvider.stream()` (SSE/NDJSON parsing in all three providers) and `text_delta` / `thinking_delta` / `tool_call_delta` events. The non-streaming `chat()` becomes a fold over the stream.
3. **Content blocks:** `content: string | ContentPart[]` with `text` and `image` (base64 / URL / file ref). Tools can return images (MCP already can), and providers map them to their wire formats.
4. **Structured output:** `ChatOptions.tool_choice` (`auto | required | {name}`), `response_format` (JSON schema; Ollama `format`, OpenAI `json_schema`, Anthropic via forced tool), and stop sequences.
5. **Loop policies:** `stop_on_tools: string[]` / `max_actions`. The loop returns as soon as a terminal "action" tool succeeds, so one observation costs one LLM call. Add a `fallback_action` returned on deadline, budget or abort, and a per-run `deadline_ms`.
6. **Parallel tool execution:** `Tool.concurrency_safe?: boolean`. Safe calls in one assistant turn go through `Promise.all`, and results are appended in call order.
7. **Prompt hooks:** add `before_llm_call(messages) → messages` and `build_system_prompt(ctx)` plugin hooks so memory, skills and world state can be injected without forking the loop.
8. **Validate tool args** against the JSON schema in the executor (or accept zod schemas and derive JSON Schema) instead of hand-coercing in each tool.
9. **Accurate context accounting:** calibrate the chars/4 estimate with the previous call's real `usage.prompt_tokens` (Hermes `agent/usage_anchor.py`), include tool-schema size, and on provider `overflow` compress-and-retry instead of failing over.
10. **Prompt caching:** keep the system prompt byte-stable for the whole session. Build it once in stable / context / volatile tiers (Hermes `agent/system_prompt.py`) and add Anthropic `cache_control` breakpoints (system prefix plus the last N messages; Hermes `agent/prompt_caching.py`). This is a large cost and latency win for long NPC conversations.
11. **Remove process-global state:** `set_log_level` at config parse; `docs_read` root from `cwd` memoized at module level; the Ollama id counter; the `url_guard` override; the `run_tests` mutex. Required for many runtimes and profiles per process.

---

## 3. Feature gaps vs Hermes (ranked for Lich's goals)

| Feature | Hermes | Lich | Recommendation |
|---|---|---|---|
| Memory | `MEMORY.md` / `USER.md` bounded entries, frozen into the prompt at session start, `memory` tool, pluggable providers | none in code | **Port.** Add namespaces (`npc:<id>`, `world`, `user`) so games get private and shared memory. |
| Skills | `SKILL.md` directories, index in the prompt, `skill_view` / `skill_manage`, security scan, curator | `.lich/skills/*.md` via `docs_search` | **Port the index + `skill_view` + `skill_manage`.** Engine-specific skills (Godot signals, Unity lifecycle…) are high value for use case A. |
| Background learning | forked review agent every N turns saves skills and memory | none (Lich's "self-improvement" is the gated `git_commit`) | Port after memory and skills land |
| Session DB + search | SQLite WAL + FTS5, `session_search` tool | JSONL files, no search | Keep JSONL as the replay log; add a SQLite/FTS index beside it |
| Subagents | `delegate_task`, depth 1, parallel batch, blocked-tool list, summary-only return | none (`persona_orchestrator` is an example) | **Port as core.** A game master delegating to NPC agents is the same primitive. |
| Toolsets | named sets + `check_fn` + per-session resolution | one `builtin` set; flat gateway allowlist | Named toolsets per Profile (`fs`, `shell`, `web`, `game`, `vision`, `memory`) |
| Approvals | pattern + human + LLM approvals, yolo mode, gateway wait | veto hooks only | `approval_required` hook result routed to the active surface (TUI prompt, serve request) |
| Steering | soft/hard interrupt, queued steer messages | one `AbortSignal` per run; one-shot/chat install no SIGINT | Per-tool cancel, "stop after this turn", queued steer message |
| Computer use / vision | `tools/computer_use/`, `vision_tools.py` | none | Needed for use case B; after content blocks |
| Trajectories / batch | ShareGPT JSONL, `batch_runner.py`, toolset distributions | session JSONL only | `lich export --trajectories` + `lich batch` for eval/episode runs |
| Cron | full scheduler + agent tool | none | Low priority for games; useful for sims ("world tick every N min") |
| Terminal backends | docker/ssh/modal/… | local `bash -lc` | Docker backend matters for safe coding agents |
| File checkpoints | shadow-git snapshot before edits | none | Cheap and high value for use case A (rollback of scene/script edits) |
| MCP server mode | `mcp_serve.py` | client only | Exposing Lich *as* an MCP server lets editors and other agents call it |

Hermes lesson: **its Atropos RL `environments/` were removed in May 2026** (`5af672c753`). The environment→loop interface is still worth reading via `git show 5af672c753^:environments/hermes_base_env.py` when designing `lich env` below.

---

## 4. Per-use-case roadmap

### (A) Coding games
- Catalog entries or recipes for Unity MCP, Unreal MCP and community Godot MCP servers (opt-in, pinned by path). Only Redot is real today; Godot is `transport: "none"`.
- Engine-aware tools/skills: headless build/run (`godot --headless --script`, Unity `-batchmode`, UE `RunUAT`), GUT/GdUnit/Unity Test Runner/UE Automation runners with parsed results, and engine log parsing.
- Screenshot → vision for visual QA of scenes (needs content blocks).
- File checkpoints (shadow git) before edits; `.tscn`/`.tres`-aware diff summaries.
- Engine skills pack (`skills/godot/…`) loaded through the new skills index.

### (B) Playing games
Nothing exists today. Proposed `lich env`:
- Interface: `reset() → obs`, `step(action) → {obs, reward, done, info}`, `action_space` (JSON schema). Observations are `ContentPart[]` (text + image).
- Adapters: a Python stdio bridge (Gymnasium, PettingZoo, stable-retro, PyBoy, mGBA), a desktop computer-use adapter (screen capture + input injection), and a browser adapter for web games.
- Scheduler: frame-skip / "act every N ticks", `deadline_ms` with `fallback_action`, and action-terminal loop mode.
- Determinism: seed + temperature pinning, recorded observations, and `lich replay <session>` to re-simulate.
- `lich bench`: episodes × models → win rate, steps, tokens, p50/p95 latency; trajectory export.

### (C) Embedded in games / sims
- **Make serve the game transport.** WebSocket JSON-RPC is the right choice: engines have WS clients, it pushes, and it cancels (better than webhook polling and the racy `orders.jsonl` file bus). For games it needs:
  - per-session concurrency (per-session queues instead of the global `run_tail`) and per-run event scoping
  - `session.create({profile})`, `session.delete`, TTL eviction, and session ownership per connection
  - **client-executed tools:** the client declares tools; the server sends `tool.invoke` and the client answers `tool.result` with a deadline. This replaces `orders.jsonl` and lets the game serve world-state queries.
  - `prompt.submit({observation, deadline_ms, seed, tool_choice, stop_on_tools})`
  - `text_delta` notifications; slimmer `llm_end` (not the whole `ChatResult`)
  - protocol versioning/capabilities in `health`; JSON Schema export of `protocol.ts` for SDK generation
  - optional non-loopback bind + TLS for dedicated servers / LAN game masters
- **`embedded` safety profile:**
  - no builtins, no `git_commit`, no network
  - hooks fail closed and have timeouts
  - output length caps and an optional content filter
  - player text tagged as untrusted
  - per-session token/rate budgets, real `usage` in replies (the webhook returns `usage: null` today)
- **Memory module** with private per-NPC and shared world namespaces, persisted, with recency + keyword retrieval (embeddings later).
- **Model routing per Profile:** a small local model for barks and chatter, a large model for the game master; response cache for repeated barks.
- **Engine SDKs:** GDScript addon (Godot + Redot; autoload + signals) first, then C# (Unity / Godot .NET), then UE C++. Each ships a sample project that replaces the file bus.
- Promote `persona_orchestrator` from copy-paste example to a library API (Profiles + Sessions make it ~20 lines).

---

## 5. Correctness / hygiene items (still open on origin)

**Correctness:**
- [ ] `tools_enabled` is applied before plugin tools and `git_commit` are registered, so the allowlist doesn't restrict them (`agent.ts:126-133`).
- [ ] A throwing `before_tool_call` hook lets the call through (fail-open), and hooks have no timeout.
- [ ] Tools requested on turn `max_turns` still execute though the model never sees the results.
- [ ] OpenAI missing tool id becomes `""` (`openai.ts:386`); failover "jitter" is deterministic.
- [ ] `http_request` always returns `ok: true`; `guard.ts:12` `startsWith("..")` path check; dead `terminal_timeout_ms` (`agent.ts:111`).
- [ ] MCP name-sanitize collisions (`mcp_names.ts`).

**Structure and duplication:**
- [ ] About 150 lines of duplicated HTTP/error helpers across the three providers → `providers/http.ts`. `ToolExecutor.format_result` duplicates `loop.format_tool_result_content`.
- [ ] Non-atomic config write; `ink`/`react` as hard deps; no `exports` map (C-7).
- [ ] No in-TUI cancel (U-3); CLI one-shot/chat install no SIGINT abort.
- [ ] #46 remaining test depth (MCP desync, platform adapters, Anthropic error paths, release script, symlink/SSRF matrix).

**Docs:**
- [ ] `godot.md:33,151` and `examples/persona_orchestrator/README.md:42` say the webhook binds `0.0.0.0`; the code defaults to `127.0.0.1`.
- [ ] `docs/architecture/overview.md` says "published npm package is 0.7.0".

**Repo hygiene:**
- [ ] `test/.tmp/` leaks (26 MB of leftover gatekeeper git repos and collide dirs locally). Tests should clean up in `afterAll`.
- [ ] 13 untracked `REVIEW-pr*-herdr.md` files at the repo root. Move them to `docs/design/reviews/` or out of the tree. `REVIEW.md` checkboxes are never ticked.
- [ ] About 40 stale worktrees under `~/code/lich-*` (many already merged): `git worktree prune`.

---

## 6. Suggested sequencing

1. **Foundation:** event envelope + per-run `on_event`, global-state removal, Runtime/Profile/Session split, core↔surface decoupling.
2. **Real-time:** streaming, `tool_choice`/structured output, action-terminal mode, parallel safe tools, deadlines + fallback actions.
3. **Serve for games:** per-session concurrency, profiles in `session.create`, client-executed tools, `embedded` profile, protocol schema export → GDScript SDK + sample.
4. **Memory and skills:** namespaced memory, skills index/`skill_view`/`skill_manage`, prompt tiers + Anthropic caching, `before_llm_call` hook, subagent `delegate`.
5. **Multimodal and play:** content blocks + vision, `lich env` + adapters, replay, `lich bench`, trajectory export.
6. **Package split** (core / runtime / cli) once the above interfaces settle.

---

## 7. Proposed documentation (drafts)

<details>
<summary><b>Draft: <code>docs/user-guide/choosing-a-game-integration.md</code></b> (for Lich users)</summary>

```markdown
# Choosing a game integration

> What you'll learn: the four ways a game or editor can talk to lich, which one
> fits your project, and the latency/safety trade-offs of each.

Lich's loop is the same everywhere: the model **thinks**, calls a tool to **act**,
**observes** the result, and repeats until it answers. What changes between
integrations is *who owns the tools* and *how messages travel*.

## Decision table

| You want to…                               | Use                         | Status        |
| ------------------------------------------ | --------------------------- | ------------- |
| Have lich edit your Godot/Redot project     | CLI/TUI + editor MCP        | available     |
| Run a turn-based enemy commander            | webhook + `game_bridge`     | available     |
| Run several named NPCs from one process     | `persona_orchestrator`      | example       |
| Drive NPCs/GMs live with streaming dialogue | `lich serve` (WebSocket)    | in progress   |
| Embed in a web/Node game with no server     | library (`create_agent`)    | available     |
| Let the agent play a game                   | `lich env` (planned)        | not yet       |

## 1. Coding a game (editor side)

Run lich in the project folder (`lich tui`). File tools are confined to
`work_dir`. Add an engine MCP server so the agent can inspect scenes instead of
guessing from text files:

    lich mcp add redot   # see redot.md

Tips:
- Put engine conventions in `.lich/skills/<engine>.md`; `docs_search` finds them.
- Set `LICH_TEST_COMMAND` to your headless test runner (e.g. GUT) so `run_tests`
  reports pass/fail.
- Commit before long sessions. Lich doesn't snapshot files yet.

## 2. Turn-based game logic (webhook + file bus)

Best for "once per round" decisions. The game POSTs a text digest to
`/message`, the model calls a game tool (e.g. `enemy_actions`), the plugin
writes `.lich/game/orders.jsonl`, and the game drains it. See godot.md.

- Latency: seconds. Budget ≥ 2 LLM calls per decision (action + closing reply).
- The webhook binds `127.0.0.1` by default. A non-loopback bind requires
  `x-lich-token`.
- Always drain the order file, even when the reply looks fine. Small models
  sometimes skip the tool or call it twice.

## 3. Many NPCs

Give each NPC its own `chat_id` (e.g. `npc:<persona>:<run>`). Runs for one id
are serialized and different ids run concurrently. Keep persona prompts short
and put shared lore in a skill file the tools can search.

## 4. Library embedding (JS/TS hosts)

For browser/Node/Electron games you can skip HTTP entirely:

    const agent = await create_agent_with_plugins(config);
    const { outcome } = await agent.run({ input: observation, history });

Pass `tools_enabled: []` plus only your game tools. Never ship `terminal` or
file tools inside a game build.

## Safety checklist for shipping

- [ ] `tools_enabled` lists only game tools (note: plugin tools and `git_commit`
      are not filtered by it today; don't load the gatekeeper in games).
- [ ] Player-typed text is treated as untrusted input, never as instructions.
- [ ] `max_turns` small (2–4) and `max_tokens` capped.
- [ ] A fallback action exists in game code if lich times out.
- [ ] Webhook/serve bound to loopback, token set.

## Latency guide (rough)

| Model                        | First token | Full short reply |
| ---------------------------- | ----------- | ---------------- |
| Local 1–3B (Ollama, GPU)     | ~0.1–0.3 s  | ~0.5–1.5 s       |
| Local 7–8B (Ollama, GPU)     | ~0.2–0.5 s  | ~1–3 s           |
| Cloud small (mini/haiku)     | ~0.3–0.8 s  | ~1–2 s           |
| Cloud large                  | ~0.5–2 s    | ~2–8 s           |

Every tool round adds one more full LLM call. Design decisions so one call is
enough.
```
</details>

<details>
<summary><b>Draft: <code>docs/architecture/how-agent-harnesses-work.md</code></b> (educational, for people building agents)</summary>

```markdown
# How an agent harness works (and why Lich is shaped this way)

> What you'll learn: the minimal parts of a tool-using agent, the design
> decisions every harness has to make, and where Lich and Hermes chose
> differently. Useful if you're building your own agent or extending this one.

## The core idea: a loop around a stateless model

An LLM is a pure function: messages in, one message out. An *agent* is the loop
you wrap around it:

    history = [system, user]
    repeat up to max_turns:
        reply = model(history, tool_schemas)        # THINK
        history.append(reply)
        if reply has no tool calls: return reply    # done
        for call in reply.tool_calls:               # ACT
            result = run_tool(call)
            history.append(tool_result(call.id, result))   # OBSERVE

That is the whole of Lich's `run_conversation` (`src/agent/loop.ts`, ~245
lines). Everything else in a harness supports this loop:

| Part            | Job                                              | Lich file                     |
| --------------- | ------------------------------------------------ | ----------------------------- |
| Provider layer  | Talk to OpenAI/Anthropic/Ollama wire formats     | `src/providers/*`             |
| Router/failover | Retry 429/5xx, then switch provider              | `src/providers/router.ts`     |
| Tool registry   | Name → schema + implementation                   | `src/tools/registry.ts`       |
| Executor        | Timeouts, abort, output clamping, never throws   | `src/tools/executor.ts`       |
| Guards/hooks    | Veto or observe tool calls                       | `src/plugins/hooks.ts`        |
| Compressor      | Summarize old turns when context fills           | `src/context/compressor.ts`   |
| Session store   | Durable transcript for resume/replay             | `src/session/*`               |
| Surfaces        | CLI, TUI, gateway, serve: how humans/games reach it | `src/cli.ts`, `src/tui`, … |

## Design decisions every harness faces

**1. Invert dependencies around the loop.** Lich's loop only knows
`ChatFn` and `ToolRunner` interfaces. Tests run the loop with fakes, and
compression reuses the same `ChatFn` (so it gets failover for free). Keep this
boundary: it is the most valuable property of the codebase.

**2. Tool results are data, errors included.** A tool that throws kills the
run. A tool that returns `{ok:false, error}` lets the model recover. Lich's
executor never throws, and every tool call gets exactly one result message,
even when cancelled. Providers reject histories with unpaired calls.

**3. Never split a tool call from its result.** Compression, truncation and
resume must treat `assistant(tool_calls)` + its `tool` messages as one unit.
Lich fixed this as A-2. Hermes's trajectory compressor enforces the same rule.

**4. Context is a budget, not a list.** Estimates (chars/4) drift. Better
harnesses anchor on the provider's reported `prompt_tokens` from the last call
and count tool schemas too. When you overflow, compress and retry.

**5. Keep the prompt prefix stable.** Providers cache identical prefixes.
Hermes builds its system prompt once per session in tiers
(stable → project context → volatile memory/skills snapshot) and never mutates
it mid-session, so every turn hits the cache. Memory written mid-session
takes effect next session. This trades freshness for large cost/latency wins.

**6. Memory vs skills.** Hermes separates *declarative* memory (short bounded
facts about the user and world, always in the prompt) from *procedural* skills
(how-to documents; only an index is in the prompt, the body is loaded on
demand). This "progressive disclosure" keeps prompts small while the agent's
knowledge grows.

**7. Events are your UI contract.** Every surface (TUI, desktop, game)
renders from the event stream: `turn_start`, `llm_end`, `tool_call_start/end`,
`final`… For multiple concurrent runs, every event needs a `run_id`/`session_id`,
must be JSON-serializable, and should stream token deltas.

**8. Safety is layered, and each layer is honest about its limits.** Lich
confines file tools with realpath checks, blocks private URLs (SSRF), scrubs
secrets from the shell env, and gates self-commits behind green tests. None of
this sandboxes `terminal`. Say so in docs, as Lich's council reviews do. For
code that ships inside a game, the right answer is *no* general tools at all.

**9. One protocol for every surface.** When the TUI, gateway and desktop each
call the agent differently, behaviour drifts. Hermes's TUI talks to a JSON-RPC
backend. Lich's `serve` is meant to be that single protocol.

## Agents in games: what changes

Coding agents optimize for correctness over many turns. Game agents optimize
for **latency per decision**:

- **One call per decision.** Make the action tool *terminal*, so the loop stops
  when it succeeds instead of asking the model to comment on its own action.
- **Force the action.** Use `tool_choice: required` or a JSON schema. Small
  models skip optional tools.
- **Deadlines and fallbacks.** The game never waits on the model; if the deadline
  passes, a scripted fallback action runs.
- **Observations are structured.** Send compact JSON state (or an image), not
  prose. Diffs beat full snapshots.
- **Identity everywhere.** Tools must know *which* NPC they serve, so memory and
  actions don't collide.
- **Replay.** Log observations, actions, seeds and model settings so a session
  can be re-simulated for debugging and evaluation.

## Further reading

- `docs/architecture/agent-loop.md`: Lich's loop contract in detail.
- `docs/design/council/*`: design reviews, including what the guardrails do
  *not* protect against.
- Hermes developer guide: `website/docs/developer-guide/` (prompt assembly,
  context compression and caching, trajectory format).
```
</details>

---

<sub>Audit sources: three parallel read-only audits (core engine, game surface, Hermes comparison), each spot-checked against `origin/main@bad1243`. No code was changed.</sub>

🤖 Generated with [Claude Code](https://claude.com/claude-code)


---

## Comment by Moikapy (2026-09-23T05:04:20Z)

## Addendum: build everything around the gateway

This follow-up proposal changes how §2 (architecture) and §4(C) (serve for games) are organized. It does **not** change the gap list.

Instead of keeping `serve` as a separate server beside the gateway, make the **gateway the hub**:
- `serve` becomes the gateway's most capable adapter.
- Every surface connects through the gateway: messaging platforms, game engine SDKs, Ossuary, and eventually the TUI.

Hermes works this way. Its `gateway/` owns sessions, one agent per session, delivery, and the cron ticks.

### Why the gateway is a good hub

A gateway is three things: a session router, a message bus, and adapters. Lich's gateway already has the two pieces games need most.

- **`gateway/bus.ts`** runs requests one at a time within each `platform:chat_id`, and runs different ids concurrently. That is the right scheduling for many NPCs. It avoids the single global `run_tail` queue that serve (#83) uses today.
- **`gateway/access.ts`** defaults to read-only tools. That is closer to a game-safe default than the CLI's `tools_enabled: "all"`, which serve inherits today.

### What has to change

Today the gateway's internal contract is text in, text out (`{text, chat_id}` in, `{reply}` back). Games need a two-way event stream, so the core widens to this:

```
Gateway core
  SessionManager   (evolves from bus.ts: per-session queue, persistence, TTL/eviction,
                    profile per session, session ownership per connection)
  Runtime          (providers, tools, MCP, memory; shared, one per process)
  Profiles         (evolves from access.ts: persona, toolsets, model route, budgets,
                    safety level "dev" | "embedded")
  Policy           (auth, rate limits, per-session token budgets, real usage accounting)
  Scheduler        (world ticks / cron for sims, as in Hermes)

Adapters, grouped by capability
  text         telegram, discord, twitch, webhook   → events folded into one reply
  streaming    SSE / WebSocket                      → text_delta + tool events
  interactive  WebSocket JSON-RPC (today's serve)   → tools the client runs (tool.invoke/tool.result),
                                                      abort, approvals, structured observations,
                                                      deadlines + fallback actions
```

### Consequences

- `serve` (#81–#84) becomes the **interactive adapter**, not its own server. Per-session concurrency, eviction, access control and usage accounting get built once in the gateway core, not once for the gateway and again for serve.
- Engine SDKs (GDScript, then C#, then UE) and Ossuary are clients of the interactive adapter.
- The TUI either embeds the gateway in-process or connects over loopback.
- The `orders.jsonl` file bus and `examples/game_bridge` polling are replaced by tools the client runs over the interactive adapter.
- `examples/persona_orchestrator` collapses into Profiles plus Sessions in the gateway core.
- The Runtime/Profile/Session split in §2b becomes the gateway core. `AgentConfig` stops embedding gateway schema; the gateway owns its config slice (§2a rule 2).

### Tradeoffs and guardrails

1. **Keep the library underneath.** The gateway is built on `Runtime`/`Session`, not in place of them. Web and Node games, tests and embedders keep calling the library in-process with no server.
2. **Local use adds a loopback hop.** Mitigate this with an in-process gateway mode for the TUI and one-shot CLI.
3. **One long-running process holds every session.** Session ownership per connection, per-profile tool limits, hooks that fail closed with timeouts, and `tools_enabled` covering plugin tools and `git_commit` all become required.
4. **Adapters must declare their capabilities.** A Telegram chat can't answer `tool.invoke`. A profile that requires tools run by the client (or streaming) may only attach to an adapter that supports them, and trying otherwise should fail loudly.
5. **Version the protocol.** The interactive adapter should advertise its capabilities and protocol version through `health`, with JSON Schema exported for generating SDKs.

### Revised sequencing (replaces §6 steps 1 and 3)

1. **Foundation:**
   - an event envelope carrying `run_id`, `session_id`, `seq` and `ts`, JSON-safe errors, and a per-run `on_event`
   - removal of global state
   - `Runtime`/`Profile`/`Session` in the library
2. **Gateway core:**
   - `bus.ts` becomes `SessionManager`, with profiles per session, persistence and TTL
   - `access.ts` becomes `Profiles` and `Policy`
   - adapters declare their capabilities
   - the gateway schema moves out of `AgentConfig`
3. **Interactive adapter:**
   - fold the serve protocol into the gateway as its WebSocket JSON-RPC adapter
   - add tools the client runs, streaming, deadlines and the `embedded` profile
   - then the GDScript SDK and a sample project that replaces the file bus
4. Steps 2, 4, 5 and 6 of §6 are unchanged: real-time loop features, memory and skills, multimodal/play, and the package split.

Open question for the serve/Ossuary track (#79): retarget #81–#84 as gateway-adapter work now, or land them as-is and fold them in during step 3.

🤖 Generated with [Claude Code](https://claude.com/claude-code)


---

## Comment by Moikapy (2026-09-23T05:10:23Z)

## Addendum 2: serve PR decision, modularity, and DRY

### A. Decision on the open serve PRs (answers the open question in Addendum 1)

None of the serve PRs have merged, so changing direction now is cheap. Recommended path:

1. **Merge #99 (#81, WebSocket transport + health) and #103 (#84, `lich serve`) as they are.** Loopback binding, the token, health and the CLI are needed in either design.
2. **Before merging #101 (#82) and #102 (#83):** move serve's `sessions.ts` bag and the global `run_tail` queue in `prompts.ts` into one shared `SessionManager` module that `gateway/bus.ts` will also use.
   - Give it a queue per session and run separate sessions concurrently.
   - Serve then calls into it.
   - This avoids building sessions + queue + eviction twice.
3. **Before #102 merges:** give every event an envelope carrying `run_id`, `session_id`, `seq` and `ts`, with JSON-safe `error` values.
   - #102 forwards `AgentEvent` values raw.
   - The Ossuary panes (#86–#94) will be written against that shape, so changing it later means touching every pane.
   - This is the most time-sensitive item.
4. **Gateway adapter migration is deferred** to the follow-up issue.

Ossuary is not blocked by this. Its client depends only on the #80 protocol method names, which are already merged and don't change.

### B. Modularity: subpath exports, not separate packages (yet)

Keep **one package** and expose layers through the `exports` map:

```jsonc
"exports": {
  ".":         "./dist/index.js",    // Runtime, Profile, Session: the main API
  "./core":    "./dist/core.js",     // loop, message/content types, events: no fs/Node APIs (browser-safe)
  "./gateway": "./dist/gateway.js",  // gateway core + adapters
  "./tui":     "./dist/tui.js"       // ink UI
}
```

- Make `ink` and `react` **optional `peerDependencies`**, used only by `./tui`. This fixes C-7: today the library pulls in the TUI.
- **Enforce the layers with lint, not with package boundaries.** Use dependency-cruiser or ESLint `no-restricted-imports`: core must not import runtime, gateway, tui or cli; runtime must not import surfaces. Run it in CI.
- **Treat these extension interfaces as stable, documented and semver-covered:** `Tool`, `Provider`, `Plugin` hooks, `Adapter`, `MemoryStore`, `Profile`. Third parties build against these; they are the actual ecosystem surface.
- Engine SDKs (GDScript, C#, UE C++) are separate packages by nature. Generate them from the serve protocol's JSON Schema.

**Not now: separate npm packages** (`@lich/core`, `@lich/runtime`…). Splitting early brings version skew, a larger public API to keep stable, monorepo and release tooling (the release script already needed several fix PRs), and more docs. The conditions for revisiting are in the follow-up issue.

### C. DRY and file organization

**Do:**
- [ ] Extract the ~150 lines of HTTP/error helpers duplicated across the three providers into `providers/http.ts`:
  - `build_abort_signal`, `do_fetch`, `read_response_text`, `parse_retry_after_ms`
  - `status_to_error_kind`, `error_name`, `is_abort_like`, `describe_error`
  - `resolve_api_key`, `first_non_empty`
  - `failover.ts` has its own copies of `error_name` and `is_abort_like`.
- [ ] Remove `ToolExecutor.format_result`, which duplicates `format_tool_result_content` in the loop.
- [ ] Deduplicate `split_text`, which appears in both `gateway/format.ts` and `telegram.ts`.
- [ ] Consolidate `src/mcp/` from 21 files of 40–60 lines into about 5 (`client`, `transport`, `catalog`, `register`, `safety`), dropping the redundant `mcp_` prefix.
- [ ] Move the flat `src/cli_*.ts` ×7 and `setup_wizard.ts` into `src/cli/`, and drop the `gateway.ts` and `tui.tsx` shims.

**Don't:**
- DRY the per-provider wire-format mapping. OpenAI, Anthropic and Ollama change for different reasons, and code that only looks similar is not duplication.
- Add abstractions for single-use code (per CLAUDE.md §2).

Deferred items (package split, adapter migration, file-bus retirement, more SDKs, TLS, memory/learning follow-ups) are tracked with revisit triggers in #114.

🤖 Generated with [Claude Code](https://claude.com/claude-code)


---

## Comment by Moikapy (2026-09-23T05:22:45Z)

## Addendum 3: project LLM wiki (`wiki/`)

The docs say **what Lich does**, and the kanban says **what to do next**. Nothing holds **what we know and why**. Today that knowledge is scattered and decays:

| Knowledge | Lives in | Problem |
|---|---|---|
| Hermes internals | subagent reports | lost at the end of the session; each new session re-researches it |
| Architecture decisions (gateway as hub, subpath exports) | #113 comments | buried; never folded into one explanation |
| Review findings | 13 untracked `REVIEW-pr*-herdr.md` files, `REVIEW.md`, council reviews | scattered; the fixed/unfixed state drifts |
| Plans | `.cursor/plans/*.md` | only one tool reads them |
| Engine facts (Godot, Redot, Unity) | nowhere | rediscovered every session |

### Proposal

An in-repo **LLM wiki**, following Karpathy's pattern as used by the Hermes `llm-wiki` skill, at `wiki/`. It has three layers:

- `raw/`: immutable sources (audit reports, issue snapshots, external references), sha256-stamped.
- `entities/`, `concepts/`, `comparisons/`, `decisions/`, `queries/`: agent-maintained, interlinked pages.
- `SCHEMA.md`: the conventions, plus `index.md` and a `log.md` that is only ever appended to.

Every tool can read it: Claude Code, Cursor, Herdr, Hermes and Lich itself.

### Guardrails

- **Docs and code stay the source of truth for behavior.** Wiki pages cite `path:line@sha` and issue numbers, and never copy kanban status.
- **Update on events, not continuously:** a PR merged, a review finished, research done, a decision made. Each update adds one `log.md` entry.
- **`wiki/scripts/lint.mjs`** checks frontmatter, index coverage and broken `[[links]]`. Agents additionally lint for stale SHAs and decisions whose revisit trigger has fired.
- **Not shipped:** the `package.json` `files` whitelist already excludes `wiki/`, and it is not part of the VitePress site.

### Why this is also a product bet

The audit found Lich has **no memory or skills subsystem**, and the game use cases need exactly this structure:

- a **lore wiki**: shared world entities plus private NPC pages, i.e. the world and NPC memory namespaces from §4(C)
- an **engine wiki** for coding agents, loaded through progressive disclosure (an index in the prompt, pages read on demand)

Using the pattern on our own project first is a cheap way to settle the format before shipping it as a `MemoryStore` (see #114 item 7).

### Checklist
- [x] Scaffold `wiki/`, seeded with this audit: the Hermes, core-engine and game-surface reports, plus snapshots of #113 and #114 and their comments.
- [x] Add the `lich-wiki` project skill (`.claude/skills/lich-wiki/`) covering orient, ingest, query and lint.
- [ ] Commit `wiki/` and `.claude/skills/` (lich-kanban, lich-wiki) in one PR (`Part of #113`).
- [ ] Add the wiki pointer to CLAUDE.md and AGENTS.md.
- [ ] Ingest the `REVIEW-pr*-herdr.md` files, `REVIEW.md` and the council reviews into `raw/reviews/`, then remove the loose files from the repo root.
- [ ] Run lint as part of the weekly kanban triage.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
