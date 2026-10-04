---
source_url: session:2026-09-23 architecture audit subagent report (see #113)
ingested: 2026-09-23
sha256: ffb55b7761fb9a9e18fdb320d90462ecac378485e5e9c83ccf85c149b145ef95
---
# Lich core engine audit (2026-09-23)

Read-only audit by a subagent during the architecture audit session (see #113).

**Baseline:** local checkout v0.8.0 (`77bc148`), which is 56 commits behind origin/main (`bad1243`, CHANGELOG 0.9.0). Every gap was checked against origin/main; items already fixed there are marked. Line numbers refer to the v0.8.0 files.

## 1. How the think-act-observe loop works (`src/agent/loop.ts`, `agent.ts`)

### Messages
- `Message` is a union of system, user, assistant and tool (`providers/types.ts:21-45`). Every `content` field is a plain `string`.
- An assistant message may carry `tool_calls: {id, name, args}[]`.
- A tool message has `tool_call_id`, `name` and an optional `is_error`.
- There are no content blocks, so images can't be represented.
- origin adds an opaque `provider_content` field on assistant messages for replaying Anthropic thinking blocks.

### `Agent.run` (`agent.ts:149-204`)
- Attaches MCP tools once, memoized (`:215-218`).
- Creates a per-run `AgentEmitter` that forwards to the shared `agent.events` (`:153-154`).
- Opens a JSONL session recorder and fires the plugin `on_run_start` hook.
- Seeds the conversation with `[...history, {user: input}]` and calls `run_conversation`.
- The system prompt is one static string, `config.system_prompt ?? DEFAULT_AGENT_SYSTEM_PROMPT` (`:28-30, :177`). `seed_system_prompt` inserts it or replaces an existing system message (`loop.ts:62-78`).
- No memory or skills are injected. Skills are reachable only through the `docs_search` tool (`docs_search.ts:167-189`).

### Each turn (`loop.ts:201-245`)
1. Check the abort signal, then emit `turn_start`.
2. `compress_if_needed`: when the chars/4 estimate reaches 0.8 × budget, older messages are replaced by an LLM summary injected as a *user* message (`compressor.ts:86-114`). The last 8 messages are kept, and the cut never lands on a tool result.
3. Emit `llm_start`, then call `deps.chat`, which is `router.chat_with_failover` (`agent.ts:227`).
   - Providers are tried in config order.
   - `rate_limit` and `network` errors get 3 attempts with deterministic backoff (`router.ts:100-122`, `failover.ts:25-33`).
   - `auth`, `overflow` and `bad_request` errors move to the next provider immediately.
4. Emit `llm_end` and push the assistant message.
5. If there are no tool calls, emit `final` and `turn_end` and return `"final"`.
6. Otherwise, run each tool call strictly one after another (`for…of await`, `loop.ts:110-121`), emitting `tool_call_start` and `tool_call_end` around `tools.execute(name, args, tool_context)`.

### Tool execution
The executor is `HookedToolRunner` (before/after hooks, where before can veto) wrapping `ToolExecutor`. `ToolExecutor` (`executor.ts:37-75`, `guard.ts:143-164`):
- never throws
- returns `unknown_tool` for unregistered names
- applies a 30s default timeout, overridable per tool
- links the timeout with the caller's abort signal
- clamps output at 20k characters

### Stop conditions
- `"final"`: the model replied with no tool calls.
- `"budget"`: `max_turns` was reached (default 25). `final` is then the last assistant message, which usually still has tool calls.
- `"aborted"`: the signal is checked before each turn, before each tool call (skipped calls get a synthetic `cancelled` result so calls stay paired), and after a chat call throws.
- Any other provider error is thrown.
- An abort emits an `error` event carrying a `DOMException` (`loop.ts:190-199`).

### Events
11 event types, synchronous and fire-and-forget (`events.ts:12-24`): `turn_start`, `llm_start`, `llm_end`, `tool_call_start`, `tool_call_end`, `compress_start`, `compress_end`, `turn_end`, `final`, `budget_exhausted`, `error`.

### Streaming
None:
- Ollama hard-codes `stream:false` (`ollama.ts:32`).
- The Anthropic and OpenAI clients read a single JSON body.
- `docs/architecture/overview.md:195` says so.

## 2. Strengths
- **Dependency-injected loop:** it sees only `ChatFn`, `ToolRunner`, `definitions()` and an emitter (`loop.ts:27-38`).
- **Failures are contained:** the executor never throws, event handlers that throw are isolated (`events.ts:40-48`), and persistence or compression failures never fail a run.
- **Abort is threaded end to end:** run → provider fetch (`AbortSignal.any` with the timeout) → tools.
- **Config is one zod schema,** parsed and then frozen (`config.ts:81-152`).
- **Small provider clients** with no SDKs: injectable `fetch`, correct error classification, and Anthropic's consecutive tool results merged into one user turn (`anthropic.ts:203-233`).
- **Serious security posture:** realpath confinement, SSRF guard, config write denial, gatekeeper, MCP refuse-list.
- **Incremental session recorder.**
- **Candid design docs and council reviews.**

## 3. Gaps, in priority order

### P0: blocks many concurrent agents (NPCs) and real-time UIs

**1. Events carry no run or session id** (`events.ts:12-24`).
- `agent.events` is shared, so concurrent runs on one Agent (as in the gateway, `gateway/runner.ts:17-21`) can't be told apart.
- There is no per-run `on_event` in `AgentRunOptions` (still true on origin).
- `error: unknown` isn't JSON-serializable, yet origin's serve pushes raw `AgentEvent` (`src/serve/protocol.ts:134-137`).
- There are no timestamps, no run_start/run_end, and no backpressure.

**2. No streaming.** It needs `LLMProvider.stream()` or `on_delta`, plus SSE parsing in all three providers.

**3. Process-global state:**
- log level set as a side effect of parsing config (`config.ts:150`)
- `docs_read` root cached at module level and resolved from `process.cwd()`, not `work_dir` (`docs_read.ts:23`, `builtin/index.ts:53-57`; still on origin)
- `docs_search` section cache
- Ollama tool-call id counter (`ollama.ts:23`)
- `url_guard` `fetch_override`
- `run_tests` module mutex
- Plugin hook state was a module-global `WeakMap` reset on each run start (`hooks.ts:31, 113-116`). **Fixed on origin** (per-run `AsyncLocalStorage.run_scope`).

**4. Agents are heavy.**
- The constructor builds its own router, 13–15 builtins (including terminal), plugins and MCP child processes.
- There is no cheap "persona" layer that shares a runtime while varying prompt, tools or model per run.
- `AgentRunOptions` has no `system_prompt`, `tools` or `model` override.

### P1: capability gaps

**5. Tool calls run one at a time** (`loop.ts:110`). There is no concurrency-safe flag on `Tool`.

**6. No structured output or tool choice.** The request bodies have no `response_format`, `tool_choice` or stop sequences (`anthropic.ts:31-38`, `openai.ts:226-244`). `ChatOptions` is only temperature, max_tokens, signal and think (`types.ts:67-73`).

**7. No vision.** Content is a string everywhere.

**8. No prompt caching.**
- Anthropic's `system` is a flat string with no `cache_control` (`anthropic.ts:192-201`).
- Compression rewrites the history prefix, which breaks caching anyway.

**9. Approximate token counting.**
- chars/4 (`tokens.ts:13-15`) ignores tool-definition schemas (large with MCP) and the output reservation.
- The previous call's `usage.prompt_tokens` is never used to calibrate.
- Compression usage was uncounted in 0.8.0. **Fixed on origin** (`compress_end.usage`).
- An `overflow` error fails over instead of compressing and retrying.

**10. No tool-argument validation.**
- Tools declare raw JSON Schema (`util/json_schema.ts`) and receive `args: Record<string,unknown>`, which the executor never validates.
- Each tool coerces by hand (`require_string_arg` and similar, `guard.ts:95-128`).
- zod is used only for config.

**11. Missing primitives.**
- No subagent or delegation primitive, and no memory subsystem.
- No plugin hook for prompts or messages. Hooks cover only tool calls and run start/end (`plugins/types.ts:46-55`).

**12. Coarse cancellation.**
- One signal per run: no per-tool cancel, skip, or "stop after this turn".
- The CLI one-shot and chat modes pass no signal and install no SIGINT abort (`cli.ts:320-360`, still on origin).

**13. Loop contract nits.**
- `turn_end` fires only on the final turn (`loop.ts:227-236`). **Fixed on origin** (A-10).
- Tools requested on turn `max_turns` still run even though the model never sees their results (still on origin).
- `finish_reason:"length"` with tool calls: **fixed on origin** for Anthropic, which now drops the truncated calls.

### P2: coupling and config

**14. Core imports surfaces.**
- `agent/config.ts:6-8` imports `gateway/access`, `gateway/token_env` and `mcp/mcp_pin`.
- `tools/builtin/terminal.ts:3` imports `gateway/token_env`.
- `session/recorder.ts:6` imports `agent/loop` (a lower layer importing a higher one).
- `mcp/*` and `gateway/*` import the `AgentConfig` type.

**15. Config is also read from `process.env` in many places.**
- `LICH_ALLOW_SELF_COMMIT` (`agent.ts:130`), `LICH_TEST_COMMAND` (`:103`), `LICH_DOCS_DIR`, provider key envs.
- `tools_enabled` is applied *before* plugin tools and the gatekeeper's `git_commit` are registered (`agent.ts:126-133`), so the allowlist doesn't restrict them. Still on origin.

## 4. Code organization

- **Mixed layout at the root of `src/`:**
  - 7 flat files: `cli.ts`, `cli_config.ts`, `cli_update.ts`, `cli_mcp*.ts` ×5, `setup_wizard.ts`
  - two entry shims that duplicate directories: `gateway.ts` beside `gateway/index.ts`, and `tui.tsx` beside `tui/`
  - MCP split into 21 files of 40–60 lines, each with a redundant `mcp_` prefix
- **One package ships everything:** `ink`/`react` are hard dependencies of the library, and there is no `exports` map.
- **Suggested layering:**
  - `core/`: messages, loop, events, compressor, tool contracts, provider interface; no Node/fs if possible
  - `runtime/`: providers, executor, registry, builtins, plugins, MCP, sessions, config
  - `surfaces/`: cli, tui, gateway, serve; each surface owns its own config slice
- **Duplication:**
  - Providers each reimplement `build_abort_signal`, `do_fetch`, `read_response_text`, `parse_retry_after_ms`, `status_to_error_kind`, `error_name`, `is_abort_like`, `describe_error`, `resolve_api_key` and `first_non_empty`. `failover.ts` has another copy of `error_name`/`is_abort_like`. About 150 lines could become `providers/http.ts`.
  - `ToolExecutor.format_result` (`executor.ts:78-83`) duplicates `loop.format_tool_result_content`.
  - `gateway/format.ts` `split_text` duplicates the one in `telegram.ts`.
- **Dead or test-only code:**
  - `ToolExecutor.format_result`
  - `ProviderRouter.default_provider`
  - `builtin_toolset`
  - `Toolset`/`register_toolset` (effectively internal)
  - `terminal_timeout_ms` / `LICH_TERMINAL_TIMEOUT_MS`: injected at `agent.ts:111` and never read (still on origin)

## 5. Issues #46 / #47 and REVIEW.md

**#47 (epic, open):**
- All must-fix issues #21–#36 are closed.
- The should-fix area PRs #68–#76 are merged on origin: agent A-7/8/10–13, providers P-2…P-8, tools S-6…S-9, MCP M-2…M-9, gateway G-4/6/8/9, CLI C-4…C-6, examples, docs.
- The epic stays open until its children close.

**#46 (open):**
- T-1 and T-2 are done (CI on Node 20/22). T-3 and T-4 are partly done via #71.
- Remaining:
  - rewrite the MCP desync and Redot-bypass tests
  - more depth for Discord/Twitch/Telegram
  - Anthropic error paths
  - tests for the release script
  - a symlink/SSRF matrix
  - a stronger assertion for cancelled tools in the transcript

**REVIEW.md** is untracked and its checkboxes are never ticked. Still unfixed on origin:

| Item | Open problems |
|---|---|
| P-9 | OpenAI missing tool id becomes `""` (`openai.ts:386`); deterministic jitter; no provider health memory; `engines >=20` while using `AbortSignal.any` and WebSocket |
| S-11 | executor clamps output to 20k characters a second time; dead `terminal_timeout_ms`; `guard.ts:12` `startsWith("..")`; docs root from cwd, memoized globally; `http_request` always returns `ok:true` |
| M-10 | MCP name-sanitize collisions (`mcp_names.ts`); a throwing `before_tool_call` lets the call through, and hooks have no timeout; `git_commit` bypasses `tools_enabled`; gatekeeper denylist gaps |
| A-11 | `set_log_level` as a side effect of config parse; `tools_enabled` names unchecked (the duplicate-provider and freeze holes are fixed on origin) |
| G-10 | `/start` rewrite (`bus.ts:91`); eviction by insertion order; shutdown not awaited |
| C-7 | config write isn't atomic; `ink`/`react` are hard dependencies; no `exports` map |
| U-3 | no cancel inside the TUI |

A-12 (session id collisions) is **fixed on origin** (pid + random).

**Relevance to NPCs:** the serve/Ossuary work (#79–#95) runs into P0 items 1 and 2 directly. A live chat pane needs per-run event scoping, JSON-safe events and streaming before it's meaningful.
