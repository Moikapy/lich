---
source_url: session:2026-09-23 architecture audit subagent report (see #113)
ingested: 2026-09-23
sha256: 7135998daf0a9cf3bfe067d2358c0d2cd91e977f0c27802085e3adfbc35f1934
---
# Hermes Agent vs Lich: research report (2026-09-23)

Produced by a read-only research subagent during the architecture audit session (see #113).

**Sources:**
- Hermes checkout at `~/.hermes/hermes-agent`, HEAD dated 2026-09-22.
- Lich v0.8.0 at `~/code/lich` (`77bc148`), about 8.2k lines of TypeScript in `src/`.

**Corrections to the original brief:**
- `~/code/lich-hermes-docs` is not Hermes documentation. It is an older Lich checkout (v0.7.0).
- `~/hermes` is empty. The real Hermes docs are in `~/.hermes/hermes-agent/website/docs/developer-guide/*.md` and the per-area `AGENTS.md` files; the routing table is at the end of the root `AGENTS.md`.

## 1. Hermes architecture map

Hermes is written in Python. It uses a "facade + siblings" layout: `X.py` is the public entry point, and `X_<topic>.py` files each own one topic (root `AGENTS.md`).

| Area | Paths | What it owns |
|---|---|---|
| Agent loop | `run_agent.py` (the `AIAgent` facade), `agent/conversation_loop.py`, `agent/turn_*.py` (~35 phase files: `turn_preflight`, `turn_api_call`, `turn_tool_round`, `turn_finalizer`, `turn_recovery`, `turn_overflow`…), `agent/agent_init.py` | Turn loop, retries, recovery, empty/truncated responses, iteration budget (`agent/iteration_budget.py`) |
| System prompt | `agent/system_prompt.py`, `agent/prompt_builder.py`, `~/.hermes/SOUL.md` | Assembled in three tiers: stable, then context, then volatile |
| Providers | `agent/*_adapter.py` (anthropic, bedrock, gemini, codex, vertex), `agent/provider_registry.py`, `agent/credential_pool*.py`, `agent/auxiliary_client.py`, `plugins/model-providers/` | Provider switching, credential pools, fallback cooldowns, a separate "auxiliary" LLM for side tasks |
| Tools / toolsets | `tools/registry.py` (tools register themselves at import; `check_fn` results cached with a TTL), `model_tools.py` (discovery, `handle_function_call`), `toolsets.py` (`TOOLSETS` dict, `_HERMES_CORE_TOOLS`), `agent/tool_executor.py` (parallel execution in a thread pool) | Schemas, gating, dispatch |
| Memory | `tools/memory_tool.py`, `tools/memory_tool_store.py`, `agent/memory_manager.py`, `agent/memory_provider.py` (ABC), `plugins/memory/` (honcho, mem0, supermemory, hindsight, holographic, retaindb…) | Built-in `MEMORY.md` / `USER.md` plus pluggable external memory |
| Skills | `tools/skills_tool.py`, `tools/skill_manager_tool.py`, `tools/skills_guard.py`, `tools/skills_hub*.py`, `tools/skill_usage.py`, `agent/curator.py`, `agent/background_review.py`, `skills/`, `optional-skills/` | Procedural memory: creation, hub, security scan, curator |
| Session DB | `hermes_state.py` + ~21 `hermes_state_*.py` (`_schema`, `_fts`, `_search`, `_wal`, `_rewind`, `_timeline`…), `tools/session_search_tool.py` | SQLite (WAL) store of sessions and messages with FTS5 search |
| Context compression | `agent/context_engine.py` (ABC), `agent/context_compressor.py`, `agent/micro_compaction.py`, `agent/native_compaction.py`, `agent/usage_anchor.py`, `plugins/context_engine/` | Pluggable compaction |
| Prompt caching | `agent/prompt_caching.py`, `agent/prompt_cache_boundary.py`, `agent/prompt_cache_scope.py` | Anthropic `cache_control` breakpoints |
| Gateway | `gateway/run.py` + `run_*.py` phases, `gateway/platforms/` (api_server, signal, webhook, bluebubbles, weixin, whatsapp_cloud…), `plugins/platforms/` (telegram, discord, slack, matrix, email, sms, teams, irc…) | Multi-platform messaging: one agent per session, delivery, pairing, profile scoping |
| Cron / kanban | `cron/jobs.py`, `cron/scheduler.py` + `scheduler_*.py`, `tools/cronjob_tools.py`; kanban in `hermes_cli/kanban*.py`, `tools/kanban_tools.py`, `plugins/kanban/` | Scheduled agent runs; a multi-agent work queue |
| Subagents | `tools/delegate_tool.py` + `delegate_tool_*.py`, `tools/async_delegation.py`, `agent/subagent_lifecycle.py`, `tools/subagent_worktree.py` | `delegate_task` |
| MCP | `tools/mcp_tool.py` + 15 `mcp_tool_*.py` (discovery, OAuth, sampling, health), `mcp_serve.py` (Hermes as an MCP server), `optional-mcps/` | MCP client and server |
| Terminal backends | `tools/environments/` (local, docker, ssh, modal, managed_modal, daytona, singularity, vercel_sandbox), `tools/terminal_tool*.py`, `tools/process_registry.py` | Where commands run |
| Safety | `tools/approval*.py`, `tools/tirith_security.py`, `tools/path_security.py`, `tools/url_safety.py`, `tools/checkpoint_manager.py` (shadow-git snapshots of files) | Approvals, blocks, rollback |
| Batch / data | `batch_runner.py`, `mini_swe_runner.py`, `trajectory_compressor.py`, `toolset_distributions.py`, `agent/trajectory.py`, `evals/` | Generating training trajectories |
| UIs | `cli.py` + `hermes_cli/cli_*_mixin.py`; `ui-tui/` (Ink/React) talking to `tui_gateway/` (Python JSON-RPC backend); `apps/desktop/` (Electron); `web/` (dashboard); `acp_adapter/` (VS Code, Zed, JetBrains) | Front ends |

**The RL environments were removed.** Commit `5af672c753` (2026-05-15, "remove Atropos RL environments and tinker-atropos integration (#26106)") deleted `environments/`: 43 files, including `hermes_base_env.py`, `agent_loop.py`, `tool_call_parsers/`, `hermes_swe_env`, and the tblite and yc_bench benchmarks. The batch and trajectory tooling survives. The old code is readable with `git show 5af672c753^:environments/hermes_base_env.py`.

## 2. Mechanisms worth copying

### Cache-stable system prompt
This is the core design rule in `AGENTS.md`. The prompt is built once per session in three tiers (`agent/system_prompt.py`, `developer-guide/prompt-assembly.md`):
- **stable:** SOUL.md identity and tool guidance
- **context:** `AGENTS.md`, `CLAUDE.md`, `.hermes.md`
- **volatile:** skills index, memory snapshot, timestamp, environment

After that, the prompt bytes never change during the session except when compaction runs. Slash commands that would change the prompt default to taking effect next session (`--now` to opt in). `agent/prompt_caching.py` places four `cache_control` breakpoints: the static system prefix plus the last three messages, all with one TTL (5m or 1h).

### Persistent memory (`MEMORY.md` / `USER.md`)
- Both files live in `~/.hermes/memories/`. Each is a bounded list of entries: 2200 characters for MEMORY and 1375 for USER by default (`tools/memory_tool_store.py`).
- One `memory` tool supports add, replace, remove and batch.
- A snapshot is frozen into the volatile tier at session start. Writes during the session reach disk but not the prompt until the next session.
- Memory is for broad facts about the user and environment; task procedures belong in skills.
- External memory providers plug in through `agent/memory_provider.py`.

### Autonomous skill creation and improvement
- A skill is `<skills>/[category/]<name>/SKILL.md` (YAML frontmatter) plus optional `references/`, `templates/`, `scripts/` and `assets/`.
- **Progressive disclosure:** only names and descriptions go in the prompt; `skill_view` loads the full content (`tools/skills_tool.py`).
- The agent writes skills itself with `skill_manage` (create, patch, delete, batch; `tools/skill_manager_tool.py`). Guards: pinned skills, read-before-write, a security scan (`tools/skills_guard.py`).
- **Background review** (`agent/background_review.py`):
  - The counters `_iters_since_skill` and `_turns_since_memory` trigger it every N iterations or turns (default 10; `agent/agent_init.py:1259-1334`).
  - It spawns a daemon thread running a forked `AIAgent` on a snapshot of the conversation, which asks "should any skill or memory be saved or updated?" and writes directly.
  - The fork inherits the cached system prompt, so it reuses the cache and never touches the main conversation.
- **Curator** (`agent/curator.py`):
  - Runs when the agent is idle (default weekly, with at least 2h idle).
  - Marks skills stale after 14 days and archives after 30 days; it never deletes.
  - Can optionally fork an LLM pass to consolidate skills.

### Session search
- The SQLite session DB has FTS5 indexes, including a CJK-bigram tokenizer (`hermes_state_fts.py`, `native/fts5_cjk/`).
- `session_search` (`tools/session_search_tool.py`) makes no LLM calls. It has four modes:
  - discovery: BM25 search, deduplicated by lineage
  - scroll: a window around one message
  - read: one session, capped at 2000 characters per message
  - browse
- Subagent and tool sessions are hidden; cron sessions are ranked lower.
- The system prompt tells the model to search before asking the user to repeat themselves.

### Toolset gating
- `toolsets.py` defines named toolsets (web, terminal, browser, skills, vision, computer_use…) resolved per platform and session.
- `check_fn` makes a tool appear only when its prerequisite is configured (for example Home Assistant or Docker).
- `AGENTS.md` rule: a capability that depends on the session is a named toolset added per session, never gated on an environment variable.

### `delegate_task` subagents (`tools/delegate_tool.py`)
- Each child is a fresh `AIAgent` with its own task_id and terminal session, and a focused prompt built from its goal and context.
- Its toolsets are the parent's minus `DELEGATE_BLOCKED_TOOLS`: delegate_task, clarify, memory, send_message, cronjob_manage (`tools/delegate_tool_toolsets.py`).
- Depth defaults to 1 (`MAX_DEPTH`, `delegate_tool_config.py:21`).
- Batch mode runs children in parallel, up to `max_concurrent_children` (default 10).
- The parent sees only the final summary. Children can be given an output schema and isolated in a git worktree.

### Cron (`cron/AGENTS.md`)
- The gateway calls `tick()` every 60s under a file lock.
- Schedules can be `"30m"`, `"every monday 9am"`, a 5-field cron expression, or an ISO one-shot time.
- Per-job options: skills to load, model override, a pre-run `script` whose stdout is injected into the prompt, `context_from` to chain job outputs, `workdir`, delivery to platforms.
- A watchdog kills a job after 600s idle, missed runs are caught up, and `next_run_at` is advanced before dispatch so a crash doesn't fire a job twice.
- The agent can schedule jobs itself through `cronjob_manage`.

### Approval of dangerous commands
- `tools/approval.py` coordinates:
  - `approval_detection.py`: hard-block and dangerous patterns
  - `approval_floors.py`: blocks and allowlists applied before prompting
  - the prompt itself: CLI, gateway, or MCP elicitation
- Also: per-session "yolo" mode and a circuit breaker for repeated denials.
- Optional "smart approval" asks an auxiliary LLM to judge risk (`approval_smart.py`). It strips shell comments, wraps the command in XML-style delimiters, and treats the command text as untrusted.
- In the gateway, approvals pause the run and wait for the user's reply (`approval_gateway_wait.py`).

### Interrupts and steering
- Interrupts are per-thread (`tools/interrupt.py`), so stopping one gateway session doesn't kill tools in others. Tools poll `is_interrupted()`.
- `agent/interrupt_control.py` adds soft and hard interrupts plus queued "steer" and "redirect" messages that change direction mid-turn without breaking user/assistant role alternation.
- `agent/estop.py` is an emergency stop.

### Context compression
Two layers (`developer-guide/context-compression-and-caching.md`):
- The in-loop `ContextCompressor` fires at 50% of the context window. It uses the real token count from the previous API response plus an estimate for what was added since (`agent/usage_anchor.py`).
- A gateway "session hygiene" pass fires at 85% before a turn starts.

Both protect the head and tail and summarise the middle. The engine is pluggable (`context.engine`), and `agent/micro_compaction.py` trims individual large tool results.

### Trajectories
- `agent/trajectory.py` writes ShareGPT-format JSONL: `trajectory_samples.jsonl` for completed runs and `failed_trajectories.jsonl` for failed ones.
- `batch_runner.py` runs a JSONL prompt dataset through a multiprocessing pool with checkpoint/resume and per-tool stats.
- It samples which toolsets are enabled for each prompt from named distributions (`toolset_distributions.py`).
- `trajectory_compressor.py` shrinks trajectories to a token budget without splitting a tool call from its result.

### Other
- `tools/code_execution_tool.py`: the model writes a Python script that calls Hermes tools over RPC, turning many calls into one.
- `tools/checkpoint_manager.py`: automatic shadow-git snapshots before file edits.
- `agent/moa_loop.py`: a mixture-of-agents loop.

## 3. Gap table (each Lich entry checked against `~/code/lich/src`, v0.8.0)

| Feature | Hermes | Lich |
|---|---|---|
| Agent loop | Many turn phases, recovery, steering | `src/agent/loop.ts`: think-act-observe loop with a `max_turns` budget |
| Tool execution | Parallel thread pool | Sequential (`loop.ts:110-118`); per-call timeout, abort and output clamping (`tools/executor.ts`) |
| Toolsets | Named toolsets + `check_fn` + per-session | `ToolRegistry.register_toolset` exists but everything is registered under `builtin`; the gateway uses a flat read-only allowlist (`gateway/access.ts`) |
| Persistent memory | Frozen `MEMORY.md`/`USER.md` + memory tool + provider ABC | None in code. `MEMORY.md` is only a README convention |
| Skills | `SKILL.md` directories, index, `skill_view`/`skill_manage`, hub, scan, curator | `.lich/skills/*.md` written with `write_file` and found by keyword via `docs_search`; "reference data, not instructions" |
| Autonomous learning | Background review fork | None. Lich's "self-improvement loop" is one gated `git_commit` per run after green `run_tests` |
| Session storage | SQLite WAL, FTS5, lineage, rewind | JSONL files, append-only (`session/store.ts`, `recorder.ts`); `--resume` in the TUI |
| Session search | `session_search` tool | None |
| Context compression | Two layers, pluggable, real token counts, micro-compaction | `context/compressor.ts`: threshold on estimated tokens, LLM summary of older turns, keeps recent turns |
| Prompt caching | 4 `cache_control` breakpoints, byte-stable prompt | None |
| Providers | 10+ adapters, credential pools, auxiliary model | openai_compat, anthropic, ollama with failover |
| Subagents | `delegate_task` | None (`examples/persona_orchestrator` is an example only) |
| Cron | Full scheduler + tool | None |
| Dangerous-command approval | Pattern, human and LLM approval, yolo mode | No interactive approval; `before_tool_call` veto hooks; gatekeeper git denylist; `work_dir` confinement; secret env scrub |
| Interrupt | Per-thread, steer/redirect | `AbortSignal` threaded through the loop, providers and tools; no steer |
| Hooks/plugins | Many plugin kinds | `before_tool_call` (veto), `after_tool_call`, `on_run_start`, `on_run_end`, plus tools |
| MCP | Client (stdio, HTTP, OAuth, sampling) + server + catalog | Client (stdio + HTTP) + catalog + pinning; no server mode |
| Gateway | ~25 platforms | webhook, telegram, discord, twitch |
| Terminal backends | local, docker, ssh, modal, daytona, singularity, vercel | local `bash -lc` |
| Browser / vision / computer use | Yes | None |
| Trajectories / batch runner | Yes | None |
| File checkpoints | Shadow git | None |
| UIs | CLI, Ink TUI, Electron desktop, web dashboard, ACP | CLI, Ink TUI, library |

## 4. Relevance to games, simulations and environments

- **RL environments (historical):** the removed Atropos `HermesAgentBaseEnv` and tool-call parsers (#26106) are the best template for a game-environment wrapper. Read them with `git show 5af672c753^:environments/{hermes_base_env.py,agent_loop.py,README.md}`.
- **Batch rollouts:** `batch_runner.py` + `toolset_distributions.py` fit mass game episodes: a parallel worker pool, checkpoint/resume, ShareGPT output with per-tool success counts. `mini_swe_runner.py` shows the same with docker or modal sandboxes.
- **Computer use** (`tools/computer_use/`): desktop control via cua-driver (screenshots, mouse, keyboard, drag), with screenshots returned as images. It could drive a real game window.
- **Vision:** `tools/vision_tools.py` (`vision_analyze`, `video_analyze`), with image token cost learned from real billing (`agent/image_token_cost.py`).
- **Browser:** accessibility-tree snapshots with `@eN` element refs, CDP; suitable for web games.
- **Code execution:** collapses many tool calls into one script, useful for simulation steps.
- **Kanban + cron:** could run long simulations or scheduled NPC ticks.
- **Cheapest ports for Lich:**
  1. trajectory JSONL export from the session recorder
  2. parallel tool execution
  3. Anthropic `cache_control` with a frozen system prompt
  4. a frozen `MEMORY.md` snapshot plus a skills index in the prompt

## Uncertain points
- The exact place the background review is triggered on the chat-completions path was not traced; only the counters were seen, in `turn_iteration_prep.py` and `codex_runtime.py:603-608`.
- The removed Atropos files were described from the commit message and file list, not read.
