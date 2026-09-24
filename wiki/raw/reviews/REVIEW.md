---
source_url: file://lich/REVIEW.md (untracked, copied 2026-09-23)
ingested: 2026-09-23
sha256: 501c42dd887962970456d7b13525d54a74ef300e5f3a6c8cc4952387276c2ef6
---
# lich — full code review

- **Reviewed:** 2026-09-19, `main` @ `b5d29cd` (v0.7.0), clean tree
- **Scope:** all of `src/`, `scripts/`, `examples/`, tests, README and user docs (~9k lines of source, ~7k of tests)
- **Baseline:** `tsc --noEmit` clean. Tests 325/326 — the one failure is environmental (see [T-1](#t-1)).

Every finding has a stable ID (`A-1`, `G-3`, …) so you can reference it in commits and issues.
Tick the box when fixed.

**Evidence labels**

| Label | Meaning |
| --- | --- |
| **repro** | Reproduced by running the real code (throwaway scripts outside the repo) |
| **read** | Confirmed by tracing the code path end to end |
| **plausible** | Code is as described; the downstream effect (e.g. a provider 400) was not run against a real service |

Nothing in the repo was modified by this review other than adding this file.

---

## Summary

The architecture is good: a dependency-injected loop, narrow interfaces, a never-throwing
executor, strict config schemas, token hygiene, and a well-built `git_commit`. The test suite is
large. The problems cluster in three places:

1. **One line breaks multi-turn everywhere.** `Agent.run` returns the history twice ([A-1](#a-1)).
   TUI, gateway, and the persona example all feed that back in, so context roughly doubles per
   turn. Tests miss it because every multi-turn test mocks `Agent.run` with the *intended* contract.
2. **The gateway is unsafe to expose as shipped.** No auth by default, binds `0.0.0.0`, no user
   allowlist on any chat platform, and the shared agent has `terminal` ([G-1](#g-1), [G-2](#g-2)).
3. **The "wards" are thinner than the README implies.** Path confinement is lexical only (symlinks
   escape), HTTP tools have no SSRF filter, the model can rewrite `.lich/config.json` to load code
   on next start, and the self-commit test gate opens with `run_tests {filter:"--help"}`
   ([S-1](#s-1)–[S-5](#s-5)).

Also: the docs still say 0.7.0 is unreleased; it is tagged and on npm ([D-1](#d-1)).

### Fix first

| # | ID | What | Effort |
| --- | --- | --- | --- |
| 1 | [A-1](#a-1) | History duplicated on every run | one line + a real multi-turn test |
| 2 | [G-1](#g-1) | Webhook: bind loopback, require token when exposed | small |
| 3 | [G-2](#g-2) | Gateway allowlists + restricted default toolset | medium |
| 4 | [S-5](#s-5) | `run_tests` filter opens the commit gate | small |
| 5 | [A-2](#a-2) / [G-7](#g-7) | Compression and history caps orphan tool results | small |
| 6 | [M-1](#m-1) | One-shot/chat never exit with a stdio MCP server enabled | small |
| 7 | [S-1](#s-1) | Symlink escape from `work_dir` | small-medium |
| 8 | [A-3](#a-3) / [A-4](#a-4) | Abort rejects the run and never reaches tools | small |
| 9 | [D-1](#d-1) | Stale "unreleased / 0.6.0" text in README, CHANGELOG, docs | trivial |

### Counts

Counted per checkbox; grouped "smaller issues" sections count each bullet.

| Area | Critical | High | Medium | Low |
| --- | --- | --- | --- | --- |
| Agent core / context / session | – | 4 | 5 | 4 |
| Providers | – | 2 | 6 | 9 |
| Tools & guardrails | – | 5 | 5 | 10 |
| Plugins / gatekeeper / MCP | – | 1 | 8 | 9 |
| Gateway | 2 | 3 | 9 | 6 |
| TUI | – | – | 2 | 5 |
| CLI / config / release / package | – | 1 | 5 | 8 |
| Examples | – | – | 1 | 3 |

---

## A. Agent core, context, session

<a id="a-1"></a>
### A-1 · HIGH · repro — history is duplicated on every multi-turn run
- [ ] `src/agent/agent.ts:186`

`run_conversation` seeds from `options.history`, so `outcome.messages` already contains it. Line 186
then builds `[...options.history, ...outcome.messages]`. Callers store `result.messages` as the
next `history`: `src/tui/app.tsx:113`, `src/gateway/bus.ts:82`,
`examples/persona_orchestrator/orchestrator.ts:55`.

Four chained runs returned 3, 8, 18, 38 messages, with `system` messages repeated mid-history.
Consequences: near-exponential token cost in the TUI; constant compression; duplicate `tool_use`
ids (Anthropic 400s); the gateway's 40-message cap fills with duplicates so real memory is ~2
exchanges.

**Fix:** `messages: outcome.messages`. Decide whether the seeded `system` message belongs in the
returned transcript. Add a test that chains two *real* `Agent.run` calls — `test/gateway.test.ts:70`
and `test/persona_orchestrator.test.ts:276` fake the correct shape and hide this.

<a id="a-2"></a>
### A-2 · HIGH · repro (provider rejection plausible) — compression splits tool-call pairs
- [ ] `src/context/compressor.ts:82-83`

The keep-recent cut is a plain `slice(-keep_recent)`. With two tool calls per turn the kept window
started with two `tool` messages whose parent assistant `tool_calls` had been summarized away.
No provider translator repairs orphans; OpenAI and Anthropic both reject them. The broken history
is already in place when the 400 arrives, so the run dies.

**Fix:** after computing `recent`, move the boundary back while `recent[0].role === "tool"`.
Same defect in the gateway cap ([G-7](#g-7)) and the persona example ([E-2](#e-2)).

<a id="a-3"></a>
### A-3 · HIGH · repro — aborting mid-LLM-call rejects `run()` instead of returning `"aborted"`
- [ ] `src/agent/loop.ts:177,190`, `src/providers/router.ts:108-116,157-171`, `src/providers/failover.ts:69-71`

The signal is only checked at the top of a turn. Mid-fetch, the AbortError is re-wrapped as
`ProviderError{kind:"unknown"}`, logged as `failing over to next provider`, and thrown. Result: no
session file, `on_run_end` skipped, the TUI drops the exchange and shows a provider error for a
user cancel.

**Fix:** in the catch around `call_chat`, return the `"aborted"` outcome when
`params.signal?.aborted`. In the router, rethrow aborts unchanged before logging a failover.

<a id="a-4"></a>
### A-4 · HIGH · read — the abort signal never reaches tools
- [ ] `src/agent/agent.ts:169`, `src/agent/loop.ts:94`

`ToolContext` has a `signal` field and the executor honors it, but the context is built as
`{ work_dir, env }`. `run_tool_calls` doesn't check the signal between calls either. A cancelled run
still executes every queued tool call, side effects included. `docs/architecture/tools.md:41`
claims the signal "fires on caller abort".

**Fix:** pass `signal: options.signal`; check `aborted` before each call and push a synthetic
`cancelled` tool result so pairing stays valid.

### A-5 · MEDIUM · repro — `usage_total` leaks between concurrent runs
- [ ] `src/agent/agent.ts:163`

`collect_usage` listens on the Agent's shared emitter, and events carry no run id. The gateway
shares one Agent across conversations, so two concurrent runs reported 4 and 2 tokens instead of 2
and 2. Wrong numbers are persisted in `run_end`.
**Fix:** per-run emitter that forwards to `this.events`, or accumulate usage inside the loop.

### A-6 · MEDIUM · read — `attach_mcp_once` races
- [ ] `src/agent/agent.ts:191-197`

`mcp_attached = true` is set before the await, so a concurrent second run proceeds with no MCP
tools; a failed attach is never retried. **Fix:** memoize the promise
(`this.mcp_attach ??= attach_enabled_mcp_tools(...)`).

### A-7 · MEDIUM · read — summarizer sees only the oldest 24k chars
- [ ] `src/context/compressor.ts:21,62`

At the default budget (100k tokens × 0.8) roughly 320k chars of history exist when compression
fires; the summarizer gets the first 24k. The most recent "older" turns vanish silently, and the
original task isn't pinned. **Fix:** truncate per message (head+tail) and scale with the budget, or
chunk.

### A-8 · MEDIUM · read/repro — no post-compression check, no back-off, usage not counted
- [ ] `src/agent/loop.ts:134-163`

A failed compression is retried every turn (× retries × providers). If the 8 kept messages alone
exceed the threshold, every turn re-summarizes and still overflows. Compression LLM calls emit no
`llm_end`, so their tokens are missing from `usage_total` (150-token call uncounted in repro).

### A-9 · MEDIUM · read — session JSONL is written once, after success
- [ ] `src/agent/agent.ts:185,232-252`

Any throw from chat loses the whole transcript, including tool side effects that already happened.
Every record's `ts` is the persist time, so the "pacing" jq recipe in
`docs/user-guide/games.md:63-65` is meaningless. The transcript holds post-compression content.
**Fix:** open the session before the loop, append as messages are produced, write `run_end` in a
`finally`.

### A-10 · LOW-MED · read — `turn_end` only fires on the final turn
- [ ] `src/agent/loop.ts:199`

`turn_start`/`turn_end` are unbalanced and the TUI's `turns_used` is stale all run.
`test/loop.test.ts` scenario A pins the current sequence. Related: tool calls requested on turn
`max_turns` execute even though the model never sees results, and the budget outcome's `final` is an
empty assistant message, so the gateway sends no reply.

### A-11 · LOW · read — config schema holes
- [ ] `src/agent/config.ts:58-78`, `src/providers/router.ts:30-52`

- Duplicate provider names: the router caches by name, so the second provider is never used.
- `freeze_config` claims a deep freeze but leaves `tools_enabled` and `plugins` mutable.
- `tools_enabled` names are unchecked; a typo silently disables a tool.
- `parse_agent_config` calls `set_log_level` — a global side effect of parsing.
- `context_budget_tokens` ignores tool definitions and the `max_tokens` reservation.

### A-12 · LOW · plausible — session id can collide across processes
- [ ] `src/session/store.ts:39-42`

`Date.now()` + per-process counter. Two processes in the same ms with the same label interleave into
one file. Add `process.pid` or open with `wx`. Also `is_message` validates only `role`; a record
with no `content` later crashes `estimate_text_tokens`. No path traversal found — labels are
slugified.

### A-13 · LOW · read — public API gaps and dead code
- [ ] `src/index.ts`

- `LoopOutcome`/`LoopParams` are exported but `run_conversation`, `LoopDeps`, `ToolRunner` are not.
- `read_session_messages`/`open_session` are not exported, so `session_path` has no programmatic reader.
- `AssistantMessage` and `JsonSchemaObject` (needed to author a `Tool`) are not exported.
- Dead: `compressor.ts:57` computes `hint` and never uses it (`model_hint` has no effect);
  `CompressParams.budget_tokens` is unused; `keep_recent: 0` never compresses (`slice(-0)`).

---

## P. Providers

<a id="p-1"></a>
### P-1 · HIGH · read — empty content becomes an empty Anthropic text block
- [ ] `src/providers/anthropic.ts:215,238,254-256`

`{type:"text", text:""}` gets a 400. Any empty assistant turn (refusal, thinking-only Ollama reply,
empty `end_turn`) is pushed to history, and every later Anthropic request replaying it fails — the
session is permanently broken. Empty user input and (plausibly) empty tool output hit the same
path. **Fix:** never emit an empty text block; skip or substitute a placeholder.

### P-2 · HIGH · read — 4096 default `max_tokens`; truncated tool calls still execute
- [ ] `src/providers/anthropic.ts:25,175`, `src/providers/openai.ts:358-364`, `src/agent/loop.ts:190-198`

Nothing outside the providers reads `finish_reason`. A `write_file` call longer than the cap is
truncated; on the OpenAI path the args fail to parse and the tool runs with `{}`, on the Anthropic
path the truncated call runs as-is. Thinking on current Claude models counts against the cap.
**Fix:** raise the default (~16k) and return an error tool result when `finish_reason === "length"`
or args were unparseable. `MAX_TOKENS_FLOOR` (`anthropic.ts:24`) is dead.

### P-3 · MEDIUM · read — root-cause error discarded on failover
- [ ] `src/providers/router.ts:115-125`

Only `error.kind` is logged; only the last provider's error is thrown. A real 400 from the primary
becomes "fetch failed ECONNREFUSED" from a backup Ollama that isn't running.
**Fix:** log message + status at failover; throw the first non-transient error or an aggregate.

### P-4 · MEDIUM · read — `Retry-After` honored with no cap
- [ ] `src/providers/failover.ts:107-113`

`retry-after: 600` sleeps 10 minutes, twice, with a healthy backup configured. Cap it; above the cap,
fail over.

### P-5 · MEDIUM · read — `temperature` always forwarded to Anthropic
- [ ] `src/providers/anthropic.ts:185-187`

Current Claude models reject sampling params with a 400, and the schema allows 0–2 where Anthropic
allows ≤1. Make it opt-in per provider.

### P-6 · MEDIUM · read — `max_tokens` on OpenAI reasoning models; overflow regex too broad
- [ ] `src/providers/openai.ts:22,240-242`

o-series/gpt-5 need `max_completion_tokens`; the resulting 400 contains "token" so it is
misclassified as `overflow`. `/context|token|length/` and the Anthropic equivalent match unrelated
errors. Nothing consumes the `overflow` kind, so it never triggers compression. 413 isn't mapped.

### P-7 · MEDIUM · read — `num_ctx` never sent to Ollama
- [ ] `src/providers/ollama.ts:63-66,246-256`

Ollama silently truncates to its small default context while lich budgets 100k tokens and never
compresses. System prompt and tool instructions fall off first, with no error. Add a `num_ctx`
provider field.

### P-8 · MEDIUM · plausible — Anthropic `thinking` blocks are dropped
- [ ] `src/providers/anthropic.ts:367-373`

Not replayed on the next turn. Likely degraded multi-step tool use; possible signature/ordering
400s. Preserve raw assistant blocks for Anthropic turns.

### P-9 · LOW-MED — smaller provider issues
- [ ] `anthropic.ts:403-414` — `refusal`, `pause_turn`, `stop_sequence` all map to `unknown`; a refusal yields an empty final reply that then triggers [P-1](#p-1).
- [ ] `openai.ts:333-340` (plausible) — a 200 carrying `{error:{…}}` (OpenRouter style) is reported as "success response without choices" and not retried. `ollama.ts:345` already handles this.
- [ ] `openai.ts:360,362` (plausible) — a missing tool-call `id` becomes `""`; after failover to Anthropic that's a 400. Generate a fallback id as `ollama.ts:379` does.
- [ ] `src/util/json.ts` — a literal `null` 200 body passes the `=== undefined` guard and throws a `TypeError`, which `failover.ts:15` classifies as `network` and retries 3×. Any programming `TypeError` in `chat()` is retried the same way.
- [ ] `router.ts:107` — no provider health memory; a dead primary costs 3 attempts + ~3.75s every turn.
- [ ] `failover.ts:25-33,76` — the "jitter" is deterministic, so concurrent callers don't spread out; the doc comment says otherwise.
- [ ] `openai.ts:184`, `anthropic.ts:164`, `ollama.ts:177` — `AbortSignal.any` needs Node ≥20.3 but `engines` says `>=20`.
- [ ] `ollama.ts:237` — per-call `think:false` can't override config `think:true`, and `think:false` is never sent.
- [ ] `src/setup_wizard.ts:18` — default model `claude-sonnet-4` is not a valid model ID; `gpt-4.1-mini` is stale. Same names appear in the README quick start.

API-key leakage: none found. Headers and request bodies are never logged; error messages carry at
most 500 chars of the server's body.

---

## S. Tools and guardrails

<a id="s-1"></a>
### S-1 · HIGH · repro — path confinement is lexical; symlinks escape `work_dir`
- [ ] `src/tools/guard.ts:13-21`

No `realpath` anywhere. With `work/link -> ../outside`: `read_file` returned the outside file,
`write_file` created a file outside, `edit_file` modified one, and `list_dir`/`grep_files`/
`disk_usage` enumerated outside. Symlinks are common in repos (`node_modules/.bin`, pnpm). When an
operator disables `terminal`, this guard is the only ward. **Fix:** after the lexical check,
`realpath` the deepest existing ancestor and the base, then re-test containment; `lstat` the leaf
for writes.

The lexical cases are handled correctly (`..`, absolute paths, `/work` vs `/work-evil`), and every
file tool does route through the guard.

<a id="s-2"></a>
### S-2 · HIGH · repro — no SSRF filtering; redirects followed unchecked
- [ ] `src/tools/builtin/fetch_url.ts:29-39,52-56`, `src/tools/builtin/http_request.ts:67-79`

Only the scheme is checked. Reaches `169.254.169.254`, RFC1918 hosts, Ollama on `:11434`, the
gateway's own `:8089/message`, and loopback MCP servers. `http_request` allows any method, headers
and body. In gateway mode the prompts come from strangers. **Fix:** resolve the host, reject
loopback/link-local/private/ULA, connect to the vetted IP, `redirect:"manual"` with per-hop
re-validation, and an operator opt-out for local dev.

<a id="s-3"></a>
### S-3 · HIGH · read — file tools can rewrite `.lich/config.json`
- [ ] `src/tools/builtin/{write_file,edit_file,read_file}.ts`; consumers `src/cli_config.ts:69-74`, `src/plugins/loader.ts:68-73`

`list_dir`/`grep_files` skip `.lich`, but read/write/edit don't. A prompt-injected model, without
`terminal`, can write `evil.mjs`, add it to `plugins` (code execution on next start), point
`base_url` at another host (API key leaves on the next request), add an `mcp_servers` command, or
read a literal `api_key`. **Fix:** deny `.lich/config.json` to file tools; allow writes under
`.lich/` only for `skills/`.

Related, **repro under Bun**: the model can write `<cwd>/.env` with
`LICH_ALLOW_SELF_COMMIT=1` and `LICH_TEST_COMMAND=true`; Bun auto-loads it on the next
`bun src/cli.ts` start (`src/agent/agent.ts:116,141`). The published `node` binary is unaffected.
Deny `.env*` in `write_file`/`edit_file`.

<a id="s-4"></a>
### S-4 · HIGH (design) · repro — `terminal` is unconfined and inherits every secret
- [ ] `src/tools/builtin/terminal.ts:70`; `README.md:18`

`bash -lc` with `{...process.env}`; `cwd` is the only confinement.
`terminal {command:"printenv FAKE_API_KEY"}` returned the key that `env_get` masked, so that masking
is moot whenever `terminal` is on. The README presents "wards" without saying they don't apply to
`terminal` or `run_tests`. **Fix:** say so plainly; spawn with a scrubbed env (drop names matching
the `env_get` secret pattern, the configured `api_key_env`, gateway token envs).

<a id="s-5"></a>
### S-5 · HIGH (within self-commit) · repro — `run_tests` filter opens the commit gate
- [ ] `src/tools/builtin/run_tests.ts:56-59`, `src/plugins/builtin/gatekeeper.plugin.ts:256-258`

The gatekeeper sets `tests_ok=true, dirty=false` on any successful `run_tests`, whatever the args.
`vitest run '--help'` and `bun test --help` both exit 0, so `run_tests {filter:"--help"}` opens the
gate with zero tests run; a filter naming one trivially passing file does the same. Needs no
`terminal`. **Fix:** reject filters starting with `-`; only set `tests_ok` when `filter` is absent.

### S-6 · MEDIUM · repro — `terminal` timeout kills only bash, not the process group
- [ ] `src/tools/builtin/terminal.ts:50-51,70,84,95-101`

`{command:"sleep 7; echo done", timeout_ms:300}` took 7035 ms: `sleep` survived and held stdout.
`sleep 6 & echo started` returned `ok:true` together with `error:"timeout"`. `npm run dev &` hangs
until the 300s executor ceiling and leaves an orphan. The existing test passes only because bash
`exec`s a lone `sleep 5`. **Fix:** `detached:true` + `process.kill(-pid, "SIGKILL")`; resolve on
`exit`; `ok=false` on timeout.

### S-7 · MEDIUM · read — `run_tests` has no kill path; its mutex can stick forever
- [ ] `src/tools/builtin/run_tests.ts:33-49,87-99`

No signal, no timeout, unbounded output buffering, and `busy=false` only runs on child close. A
hanging or watch-mode test command leaves every later call returning `run_tests_busy` for the life
of the process. (No shell injection: the command comes from operator env and the filter is
single-quoted.)

### S-8 · MEDIUM · repro — `grep_files` ReDoS freezes the process
- [ ] `src/tools/builtin/grep_files.ts:61-69,196`

`^(a+)+$` against one 31-char line took 1035 ms under a 500 ms executor timeout — synchronous regex
blocks the timer. Each extra char doubles it, and the model can plant the file. The walk never
checks `signal`; `max_results` is unbounded. **Fix:** cap line length before `regex.test`, check
`signal.aborted` per file, clamp `max_results` (or use RE2/a worker).

### S-9 · MEDIUM · repro — HTTP tools buffer the whole body before clamping
- [ ] `fetch_url.ts:64`, `http_request.ts:81`, `web_search.ts:112`

A 300 MB response with `max_chars:10` raised RSS by 913 MB. Stream with a byte cap; reject on an
oversized `content-length`. `fetch_url` only rejects `image/*` and `octet-stream`, so zip/pdf/video
decode as text.

### S-10 · MEDIUM · read — `edit_file` corrupts `$` in replacements and can't delete
- [ ] `src/tools/builtin/edit_file.ts:26,67`

`content.replace(old, new)` interprets `$&`, `$$`, `` $` ``, `$'`: `pid=$$` is written as `pid=$`.
The `replace_all` branch (split/join) behaves differently. `require_string_arg` rejects `""`, so a
span can't be deleted. **Fix:** `content.replace(old_string, () => new_string)`; accept empty
`new_string`.

### S-11 · LOW — smaller tool issues
- [ ] `read_file.ts:27` — whole file read with no size check; `limit:10` on a multi-GB file still exhausts memory.
- [ ] `executor.ts:12-14,68` (repro) — everything is re-clamped to 20,000 chars, making per-tool limits (`read_file` 256k, `fetch_url` 100k, `docs_read` 30k) dead, and the "N chars omitted" count wrong.
- [ ] `agent.ts:115` vs `terminal.ts:114` — **`terminal_timeout_ms` is a dead setting.** `LICH_TERMINAL_TIMEOUT_MS` is injected and read nowhere; `docs/user-guide/cli.md:140` documents it as working.
- [ ] `guard.ts:17` (repro) — `relative.startsWith("..")` rejects legitimate names like `..hidden.txt`. Use `=== ".."` or `startsWith(".." + path.sep)`.
- [ ] `guard.ts:79-87` (repro) — if a plugin's `execute` throws synchronously, the timer is never cleared and later rejects unhandled; under Node that kills the process. Wrap with `Promise.resolve().then(...)`.
- [ ] `disk_usage.ts:46-49` — one unreadable subdir makes the whole call return `du_unavailable`; no signal wired.
- [ ] `env_get.ts:7` — masking is name-based; `DATABASE_URL`, `*_DSN`, `*_PAT`, `*_COOKIE` are revealed; value lengths always disclosed.
- [ ] `builtin/index.ts:53-57` + `docs_read.ts:23` — docs root resolves from `process.cwd()` not `work_dir`, memoized at module scope; a project's own `docs/index.md` is served as "lich docs".
- [ ] `grep_files.ts:75` — stray labelled statement `abort_marker: void 0;` after a `return`.
- [ ] `http_request.ts:89` — always `ok:true`, even on 4xx/5xx; inconsistent with `fetch_url`.

---

## M. Plugins, gatekeeper, MCP

<a id="m-1"></a>
### M-1 · HIGH · repro — one-shot and chat never exit with a stdio MCP server enabled
- [ ] `src/cli.ts:283-306,557-566`, `src/agent/agent.ts` (no `close()`), `src/mcp/mcp_attach.ts:40`

`run_cli` only sets `process.exitCode`; the MCP child's pipes keep the event loop alive.
`node dist/cli.js "hi"` prints the answer then hangs (exit 124 under `timeout`), on Node and Bun.
This breaks scripting with 0.7.0's headline feature. **Fix:** add `Agent.close()` that closes MCP
sessions, call it in `finally` in one-shot/chat/TUI/gateway, `unref()` the child as a backstop.

### M-2 · MEDIUM · repro — one timed-out MCP request desyncs the session permanently
- [ ] `src/mcp/mcp_pipe.ts:21-42`

`read_id` reads FIFO and discards non-matching ids; there's no id→resolver table. After request 1
times out, its abandoned reader eats the replies to 2 and 3, which also time out. Also triggered by
concurrent gateway runs, >32 notification lines (`SKIP_LIMIT`), or a server-initiated request.
**Fix:** one reader pump with a `Map<id, resolver>`; ignore messages that carry `method`.

### M-3 · MEDIUM · read — MCP attach has no timeout; calls ignore cancellation
- [ ] `src/mcp/mcp_attach.ts:19`, `mcp_pipe.ts:23`, `mcp_http.ts:10`, `mcp_register.ts:24`

A silent server blocks every `Agent.run` forever, before the first LLM call. `fetch` carries no
signal; a user abort waits the full 120s. **Fix:** 10–15s attach deadline; thread the signal.

### M-4 · MEDIUM · repro — the MCP refuse-list is a footgun guard, not a boundary
- [ ] `src/mcp/mcp_refuse.ts:1-9,27-41`

Only the command basename is checked. All accepted: `env npx -y x`, `sh -c "npx -y x"`,
`bash -c "curl …"`, `bun x`, `pnpm dlx`, `uv tool run`, `node -e`, `python3 -c`. The header says
"Refuse downloaders, shells" but no shell is in the set. The `env` key accepts `PATH`,
`NODE_OPTIONS`, `LD_PRELOAD`. The README states these "are refused" as a guarantee.
**Fix:** document it honestly, or refuse shells/interpreters and scan `args[0..1]`.

What holds up well: `/usr/bin/npx` is refused, and the loopback URL check is solid
(`127.0.0.1.evil.com`, userinfo tricks, `[::1]`, `0.0.0.0` all refused; `redirect:"error"`).

### M-5 · MEDIUM · repro — Redot pin and `execute` exclusion key off the config *name*
- [ ] `src/mcp/mcp_pin.ts:8-10`, `src/mcp/mcp_register.ts:48`

A server named `my_redot` running `redot --script evil.gd` is allowed and registers
`mcp_my_redot_execute`. `test/mcp_client.test.ts:226` asserts this as intended.
**Fix:** also apply when `basename(command)` matches.

### M-6 · MEDIUM · read — gatekeeper "per-run" state is per-Agent
- [ ] `src/plugins/hooks.ts:124-127`, `src/gateway/bus.ts:77-80`

Two gateway chats share one Agent. Run B's `call_run_start` resets `commits` mid-run-A, so more
than one commit per run is possible; chat A's write during chat B's `run_tests` gets marked clean.
Key the state on a per-run token.

### M-7 · MEDIUM · read — `dirty` ignores other writers and failed writes
- [ ] `src/plugins/builtin/gatekeeper.plugin.ts:251-255`

Only successful `write_file`/`edit_file` set `dirty`. Redot MCP tools, plugin tools and `terminal`
don't, and the `ok !== true` early return skips a write that timed out in the executor but may
still complete. **Fix:** fail closed — mark dirty on every attempt by any tool not on a read-only
allowlist, before the `ok` check.

### M-8 · MEDIUM · repro — runtime differences in stdio transport
- [ ] `src/mcp/mcp_stdio_node.ts:25-40` — no `'error'` listener on `child.stdin`; an `EPIPE` is uncaught and crashes lich under Node (Bun swallows it).
- [ ] `src/mcp/mcp_stdio_bun.ts:37` — under Bun, an `env` entry *replaces* the child's environment (no `PATH`/`HOME`); Node merges. The Node merge also hands the MCP child every provider key and gateway token. Use `{...process.env, ...env}` on Bun; consider a minimal env on both.

### M-9 · LOW-MED — untrusted MCP metadata is unbounded
- [ ] `src/mcp/mcp_result.ts:40-44`, `mcp_register.ts:34-35`, `mcp_content.ts:23`

`description` and `inputSchema` flow into tool definitions with no size limit; `clamp_result` clamps
`output` but not `error`. Names have no length cap (106 chars passed); providers cap at 64, so one
long name would plausibly 400 every request.

### M-10 · LOW — smaller plugin/MCP issues
- [ ] `mcp_names.ts:2-8` (repro) — sanitizing collides: `("a_b","c")` and `("a","b_c")` both become `mcp_a_b_c`; the second is dropped silently and an allowlist entry can bind to the wrong server. The header comment says collisions can't happen.
- [ ] `hooks.ts:76-84,106` — a throwing `before_tool_call` hook lets the call through; hooks have no timeout. `types.ts:27` says "other hooks still run" but the code returns at the first block, so audit plugins never see blocked calls.
- [ ] `loader.ts:38-44` — only `name` is validated; `tools: {}` throws inside the `Agent` constructor instead of warn-and-skip.
- [ ] `gatekeeper.plugin.ts:56-66` (repro) — denylist gaps: `git "commit"`, `git -c alias.c=commit c`, `git revert`, `cherry-pick`, `merge --no-ff`, `am` all pass, even with self-commit unset. False positives: `grep -rn push src/`, `git stash push`, `echo please commit later`. (The terminal floor is documented; these are the concrete gaps.)
- [ ] `gatekeeper.plugin.ts:75,196` (plausible) — global git config applies; `commit.gpgsign=true` would sign with the human's key or hang on pinentry. Add `-c commit.gpgsign=false`.
- [ ] `agent.ts:137-144` — `git_commit` is registered after `filter_registry`, so `tools_enabled: ["read_file"]` still exposes it (still gated).
- [ ] `mcp_plan.ts:23` (repro) — `existsSync` accepts a directory named `redot` on `PATH`.
- [ ] `mcp_http.ts:13` (plausible) — `accept` omits `text/event-stream` and `Mcp-Session-Id` isn't replayed; spec-compliant HTTP servers may 406 or reject `tools/list`.

---

## G. Gateway

<a id="g-1"></a>
### G-1 · CRITICAL · read — webhook is unauthenticated by default and binds all interfaces
- [ ] `src/gateway/webhook.ts:64,135`

The token check only runs when `LICH_GATEWAY_TOKEN` is set, and the server listens on `0.0.0.0`.
`lich gateway webhook` (documented as zero-config) gives anyone who can reach `:8089` a prompt into
an agent with `terminal`. Neither the startup log nor `docs/user-guide/gateway.md` warns.
**Fix:** default to `127.0.0.1`; require an explicit host to expose; refuse to start (or warn
loudly) on a non-loopback bind with no token.

<a id="g-2"></a>
### G-2 · CRITICAL · read — no allowlist on any chat platform; full toolset for everyone
- [ ] `src/gateway/telegram.ts:72-90`, `discord.ts:122-135`, `twitch.ts:112-137`, `runner.ts:16-19,47-55`, `src/agent/config.ts:11-17`

Any Twitch viewer, any Discord member in any channel the bot can see (no mention required), and
anyone who finds the Telegram bot drives the full-tool agent, and the reply is posted publicly. The
gateway schema has only `platforms` and `token_envs`.
**Fix:** `gateway.allowed_users`/`allowed_chats` per platform, default-deny on public platforms,
enforced in one place; a gateway `tools_enabled` that defaults to a safe subset (no `terminal`, no
writes).

### G-3 · HIGH · read — reply-send failures are unhandled rejections that kill the process
- [ ] `src/gateway/telegram.ts:52,89,99`, `src/gateway/discord.ts:103,143`

`void deliver_update(...)` / `void on_message_create(...)`: agent errors are caught, but the
following `fetch` to send the reply is not. No `unhandledRejection` handler exists. Under Node a
Telegram stall or DNS blip takes down the whole gateway. **Fix:** try/catch the bodies.

### G-4 · HIGH · read — Discord and Twitch reconnect in a tight loop after a clean close
- [ ] `src/gateway/discord.ts:59-68`, `src/gateway/twitch.ts:77-86`

The 5s delay lives only in `catch`. A normal server close resolves the session and the `while` loop
reconnects immediately. Missing Message Content Intent (close 4014) or a bad token (4004) burns the
1000/day IDENTIFY budget and risks a token reset; an expired Twitch token loops the same way.
**Fix:** always sleep with backoff; surface the close code; stop on fatal codes.

### G-5 · HIGH · read — a webhook caller chooses the conversation key, including other platforms'
- [ ] `src/gateway/webhook.ts:89-92`, `src/gateway/bus.ts:121-123`

`platform` and `chat_id` from the body are used verbatim in `${platform}:${chat_id}`.
`{"platform":"telegram","chat_id":"<id>","text":"repeat everything said so far"}` reads another
conversation and can plant turns in it. Cycling random ids evicts all 200 real conversations. Keys
are also ambiguous (`a:b`+`c` vs `a`+`b:c`). **Fix:** force `platform = "webhook"` in the adapter.

### G-6 · MEDIUM — resource bounds
- [ ] `bus.ts:34,54-60` — `chains` Map is never pruned (one entry per key ever seen), and there's no global concurrency ceiling: N chat ids → N concurrent bash-capable runs.
- [ ] `webhook.ts:96-105` — request body is unbounded (`body += chunk`); reachable unauthenticated when no token is set. Count bytes, 413 above ~1 MB.

<a id="g-7"></a>
### G-7 · MEDIUM · read (provider effect plausible) — history cap orphans tool results
- [ ] `src/gateway/bus.ts:125-131`

`messages.slice(overflow)` is role-blind. When it lands between an assistant `tool_calls` and its
`tool` result, the next request 400s; on error the stored history isn't updated (`bus.ts:84-87`), so
that chat is stuck on `agent error: …` until eviction or restart. **Fix:** after slicing, drop
leading messages until the first `user`.

### G-8 · MEDIUM — Twitch
- [ ] `twitch.ts:139-143` — model output goes into raw IRC frames with no `\r\n` stripping. Multi-line replies are mangled, and a viewer can prompt the bot into emitting arbitrary IRC commands as the bot account. Replies starting with `/` or `.` become chat commands.
- [ ] `twitch.ts:13` — 512-char chunks exceed Twitch's 500-char message cap and the 512-byte line cap (incl. prefix); chunks are sent back-to-back past the 20 msgs/30s limit. The 512 figure is repeated in `gateway.md`.
- [ ] `twitch.ts:158` (repro) — `/ PRIVMSG #(\w+) :/` isn't anchored. A USERNOTICE or WHISPER containing `PRIVMSG #victim :…` parses as a message in `#victim`, and the reply is posted there. Anchor: `^(?:@\S+ )?:(\w+)!\S+ PRIVMSG #(\w+) :(.*)$`.

### G-9 · MEDIUM — Discord
- [ ] `discord.ts:13` — intents `512 | 32768` omit `DIRECT_MESSAGES` (4096); DMs never arrive although `gateway.md` says "DM or any channel".
- [ ] `discord.ts:91-116` (plausible) — no handling of op 1/7/9, no ACK tracking, heartbeat always sends `d: null`. A half-open socket leaves the bot silently dead.
- [ ] `discord.ts:146` — no `allowed_mentions: { parse: [] }`; the bot can be made to ping `@everyone`. 2000-char chunks can split a surrogate pair; a 429 drops the chunk.

### G-10 · LOW
- [ ] `types.ts:78-84` — `globalThis.WebSocket` needs Node 22; on Node 20/21 (allowed by `engines`) Discord/Twitch fail every 5s forever.
- [ ] `discord.ts:168`, `telegram.ts:81` — empty/attachment-only messages still run the agent; Telegram service messages (joins, pins) are sent to the model as "media not supported yet".
- [ ] `runner.ts:103-111` — shutdown does `void adapter.stop()` then `process.exit(0)`; nothing is awaited. A webhook `EADDRINUSE` is logged and the gateway keeps running with zero adapters.
- [ ] `bus.ts:98-107` — eviction is by creation order, not recency (`Map.set` keeps position). `delete` before `set`.
- [ ] `bus.ts:77` — `text.startsWith("/start")` rewrites on every platform: "/started the deploy…" becomes "hello".
- [ ] `webhook.ts:64` — token compared with `!==` (not timing-safe). `text: null` is sent as `"null"`; objects as `"[object Object]"`; invalid JSON reports "text is required"; `/message?x=1` is a 404.

---

## U. TUI

### U-1 · MEDIUM · read — Enter is accepted while a run is in flight
- [ ] `src/tui/command_bar.tsx:26-34`, `src/tui/app.tsx:199-211`

`busy` only changes the prompt glyph. Two Enters start two runs from the same stale `history_ref`;
the loser's exchange is lost, the first run can no longer be aborted, and both listeners sit on the
shared emitter so tool rows and usage double. **Fix:** ignore message input while
`state.phase !== "idle"`.

### U-2 · MEDIUM · read — Up-arrow history recall is stuck on the newest entry
- [ ] `src/tui/command_bar.tsx:36-57`

The ring is newest-first, but Up walks `-1`: the first Up lands on index 0 and every further Up
clamps there. After "a", "b", "c": Up, Up, Up shows "c", "c", "c". **Fix:** Up → `walk_recall(1)`,
Down → `walk_recall(-1)`, and clear the buffer when Down passes index 0.

### U-3 · LOW
- [ ] `app.tsx:55,129-131` — every provider failure prints two identical error lines (event + catch).
- [ ] `app.tsx:121`, `state.ts:86-94` — `budget_exhausted`/`last_error` never reset; the red notice sticks for the session.
- [ ] No way to cancel a run without quitting: Ctrl+C exits, Escape is ignored, the `aborted` branch is effectively unreachable.
- [ ] `/clear` clears the screen but not `history_ref`; `/help` doesn't say so.
- [ ] `state.ts:99-110` — any input starting with `/` is a command, so "/etc/hosts looks wrong" → "unknown command".

---

## C. CLI, config, release, package

### C-1 · HIGH · repro — `lich mcp add` with no project config shadows every other config source
- [ ] `src/cli_mcp_store.ts:8-14,34-49`, `src/cli.ts:244-255`

It writes `.lich/config.json` containing only `mcp_servers`. `build_config` uses the env provider
only when *no file* is found, so afterwards `LICH_MODEL=llama3.2 lich "hello"` fails with
`no model configured`, and `~/.config/lich/config.json` is shadowed too.
**Fix:** fall back to the env provider when a discovered file has no `providers`.

### C-2 · MEDIUM · read — release commits and tags before build/pack/audit
- [ ] `scripts/release.ts:200-220`

Order is typecheck → test → bump → **commit+tag** → build → pack → audit → push. README:284-288 says
it packs and audits *before* committing. A build/pack/audit failure, the tarball-exists check
(`:148`), or a rejected push leaves a local release commit and tag; re-running skips a version. No
`git fetch`/behind-origin check, no tag-exists check.
**Fix:** bump → build → pack → audit → commit → tag → push, restoring `package.json` on failure.

### C-3 · MEDIUM · read — the release gate tests a stale `dist/`
- [ ] `scripts/release.ts:205-213`, `test/game_bridge.test.ts:298-330`

Tests run before `build`, and that test executes `node dist/cli.js`. On a fresh clone it fails;
otherwise it tests an older build. The audit checks only name and version. **Fix:** build first;
assert `dist/cli.js` + `dist/index.js` are in the tarball; smoke `--version`.

### C-4 · MEDIUM · repro — `--provider-kind` keeps the old `base_url`
- [ ] `src/cli.ts:195-217`, `src/cli_config.ts:48-59`

`lich init --provider-kind anthropic --model …` writes
`{kind:"anthropic", base_url:"http://localhost:11434"}`, so Anthropic requests go to the local
Ollama port. **Fix:** when kind is overridden and base URL isn't, reset `base_url` and
`api_key_env` to the kind's defaults.

### C-5 · MEDIUM · repro/read — `lich chat`: no memory, quits on blank line, breaks on piped stdin
- [ ] `src/cli.ts:308-361`

- `run_chat_turn` calls `agent.run({ input })` with no `history`; every turn is memoryless, though `AgentRunOptions.history` docs name "CLI chat" as a multi-turn caller.
- A blank line returns 0 — a stray Enter quits.
- `printf 'a\nb\nc\n' | lich chat` processes only `a`, then throws `readline was closed`, exit 1.

**Fix:** `for await (const line of rl)`, keep `history` from `result.messages` (after [A-1](#a-1)),
`continue` on blank.

### C-6 · MEDIUM · read — `lich update` treats any `node_modules` path as an npm global
- [ ] `src/cli_update.ts:79-103`

Bun-global (supported per CHANGELOG 0.5.1), pnpm/yarn global, and project-local installs all run
`npm install -g`, creating a second copy and printing "updated" while `lich` on `PATH` is unchanged.

### C-7 · LOW
- [ ] `cli_config.ts:103-126` — non-atomic write (truncate in place), no locking around `cli_mcp_*` read-modify-write, file created `0644` while the schema accepts a plaintext `api_key`. Temp file + rename, mode `0o600`.
- [ ] `setup_wizard.ts:158-170`, `config.ts:65` — `api_key_env` isn't validated as an env-var name (gateway token envs are). Pasting `sk-…` at that prompt writes the secret to the config.
- [ ] `setup_wizard.ts:140-147` — a second invalid provider kind silently becomes `ollama`.
- [ ] `cli.ts:113-161,522-554` — no `-h`/`-v` (sent to the model as a task); `--` unsupported; values starting with `--` rejected for every flag; extra positionals ignored for `config`/`tui`; `argv.includes("mcp")` enables mcp flag parsing for any argv containing the word (`lich explain mcp --url x`).
- [ ] `cli_update.ts:44-76,182,215` — prerelease identifiers not compared; `+build` makes a version "invalid"; no timeout on `npm view`/`npm install`.
- [ ] `cli_mcp_*` — `lich mcp list` reads only the project file, not the home config that would load; a hand-edited non-snake_case entry can't be removed via the CLI.
- [ ] `package.json` — `ink`/`react` are hard deps for library consumers though the TUI is lazy-loaded; no `exports` map; `src/index.ts:8-16` reads `../package.json` at import time (breaks single-file bundling — inject via tsup `define`); `--sourcemap` ships ~500 KB of maps pointing at unshipped `src/`.
- [ ] `engines: node >=20` is too loose: `AbortSignal.any` needs 20.3, `WebSocket` needs 22.

---

## E. Examples

### E-1 · MEDIUM · read (exploit plausible) — persona server runs with auth off
- [ ] `examples/persona_orchestrator/server.ts:35-88`, `run.ts:22`

`run.ts` passes no token. No Host/Origin/Content-Type check and no body cap. A cross-origin
`text/plain` POST to `127.0.0.1:8090/message` needs no preflight, so any web page can drive the
agent; with DNS rebinding it can read replies from the `chronicler` persona, which has `read_file`.
It does bind `127.0.0.1`. **Fix:** require a token, validate `Host`, require `application/json`,
cap the body.

<a id="e-2"></a>
### E-2 · LOW
- [ ] `orchestrator.ts:26-31` — `chains` never evicted and `enqueue` runs before persona validation; one Agent per persona but serialization per `chat_id`, so two chats run concurrently on one Agent (usage cross-talk, see A-5).
- [ ] `history_queue.ts:10-16` (plausible) — `cap_history` slices at an arbitrary index; comment says it keeps the system prompt, it doesn't; can orphan tool results.
- [ ] `game_bridge/meteor_veto.mjs:8-20`, `enemy_actions.mjs:22-32` — the veto trusts the model-supplied `round`; match is case-sensitive (`"Meteor"` passes); empty `actions` accepted; no length caps.

---

## D. README and docs accuracy

<a id="d-1"></a>
### D-1 · docs say 0.7.0 is unreleased; it is tagged, pushed, and on npm
- [ ] `npm view @moikapy/lich version` → `0.7.0`; tag `v0.7.0` exists on origin; `package.json` is `0.7.0`.

Stale in: `README.md:259-262`, `CHANGELOG.md:3` (`## 0.7.0 (unreleased)` — shipped in the tarball),
`docs/index.md:71`, `docs/getting-started.md:13,156,168`, `docs/architecture/overview.md:6-7,104`,
`docs/user-guide/cli.md:22,32,34,130`, `docs/user-guide/redot.md:31`,
`docs/user-guide/library.md:150`, `docs/user-guide/tui.md:12,17`. A release pre-flight that fails
when the CHANGELOG lacks `## <next>` or contains "(unreleased)" would prevent a repeat.

### D-2 · claims that don't match the code
- [ ] README:284-288 — "packs + audits … before committing, tagging". Order is the reverse ([C-2](#c-2)).
- [ ] README:255-257 — "`npx`, `npm`, `bunx`, `uvx`, `curl`, `wget` … are refused" reads as a guarantee; trivially bypassed ([M-4](#m-4)).
- [ ] README:18 — "the lair / wards" without saying `terminal` and `run_tests` are outside them ([S-4](#s-4)) and the guard is lexical ([S-1](#s-1)).
- [ ] README:205, `state.ts:282` — "Up/Down history recall": Up is stuck ([U-2](#u-2)).
- [ ] README:51,54 — `gpt-4.1-mini` and `claude-sonnet-4` in the quick start; the latter isn't a valid model ID.
- [ ] `docs/user-guide/cli.md:140` — `terminal_timeout_ms` documented as working; it's dead ([S-11](#s-11)).
- [ ] `docs/user-guide/gateway.md` — "DM or any channel" (DM intent missing), 512-char Twitch chunks, "graceful stop", and no warning that the webhook is open by default.
- [ ] `docs/architecture/tools.md:41` — signal "fires on caller abort"; it never reaches tools ([A-4](#a-4)).
- [ ] `docs/user-guide/games.md:63-65` — pacing recipe over `.ts`; all timestamps are persist time ([A-9](#a-9)).

### D-3 · gaps
- [ ] Env vars read by the code but absent from the README table: `LICH_DOCS_DIR`, `LICH_TERMINAL_TIMEOUT_MS`.
- [ ] No trust-model section: what plugins, MCP servers, `terminal`, and gateway users can each do.

What checks out: the tools table matches `builtin/index.ts` exactly; the TUI slash commands and the
50-block cap match `state.ts`; chat's `/exit`, `/quit` match `cli.ts:352`; gateway env vars match.

---

## T. Tests and CI

<a id="t-1"></a>
### T-1 · the one failing test is environment-sensitive
- [ ] `test/self_improve_e2e.test.ts:177`

It asserts that `bun test` output contains the test name `greet_fixture works`. Bun suppresses
passing-test names when `CLAUDECODE=1` (or similar agent vars) is set. It passes in a plain shell
and with `env -u CLAUDECODE`. **Fix:** assert on `[exit 0]` / `1 pass` instead.

### T-2 · there is no test CI
- [ ] `.github/workflows/` contains only `docs.yml`. Typecheck and tests gate nothing except the local release script. Add a workflow running `tsc --noEmit` and vitest on Node 20 and 22.

### T-3 · mocks that hide real bugs
- [ ] Every multi-turn test mocks `Agent.run` with the intended contract (`test/gateway.test.ts:70`, `test/persona_orchestrator.test.ts:276`), which is why [A-1](#a-1) shipped.
- [ ] `test/game_bridge.test.ts:303,327` does `rm -rf <repo>/.lich/game` — it deletes a developer's real local state — and depends on a prebuilt `dist/`.
- [ ] `test/mcp_client.test.ts:226` asserts the renamed-Redot bypass ([M-5](#m-5)) as intended behavior.
- [ ] `test/loop.test.ts` scenario A pins the unbalanced `turn_end` sequence ([A-10](#a-10)); scenario C exercises tools running *after* an abort.

### T-4 · highest-value missing tests
- [ ] Two chained real `Agent.run` calls (A-1); compression with assistant/tool messages and a pairing invariant (A-2); abort mid-chat and mid-tool (A-3, A-4); concurrent runs on one Agent (A-5, A-6, M-6).
- [ ] Symlinks in every file tool; `.lich/config.json` and `.env` writes; `terminal` with compound/background commands; real `run_tests` spawn with timeout and flag-like filters; `edit_file` with `$&`/`$$` and empty `new_string`; ReDoS patterns.
- [ ] MCP: silent server, out-of-order ids, >32 notifications, child crash mid-call, process exits after one-shot with a stdio server.
- [ ] Gateway: Discord has no tests at all; webhook with no token, oversized body, caller-supplied `platform`; Twitch spoofed PRIVMSG and CR/LF; Telegram poll loop and send failure.
- [ ] Providers: Anthropic has no error-path tests (429/529/400/401); empty-content messages; `finish_reason: length`; mixed-provider failover replaying tool ids.
- [ ] `scripts/release.ts` has no tests; `audit_tarball` is exported for testing and unused.

---

## Strengths worth keeping

- **Loop design.** `run_conversation` depends on narrow structural interfaces (`ChatFn`, `ToolRunner`), copies its input and never mutates it, and a test asserts that.
- **Failure containment.** `ToolExecutor` never throws; unknown tools become `is_error` results so pairing holds outside compression. The emitter snapshots handlers and isolates throwing ones. Persistence and compression failures never fail a run.
- **Strict config.** MCP entries are `.strict()`; env-var and server names are regex-checked; token *values* are kept out of config; session and theme filenames are sanitized.
- **Provider layer.** Correct merging of consecutive tool results for Anthropic; timeouts retried while caller aborts are not; `OPENAI_API_KEY` is never auto-sent to a custom `base_url`; error bodies truncated; injectable `fetch`.
- **`git_commit` itself.** argv spawn (no message injection), `--` before paths, pathspec magic rejected, secret basenames refused, scoped `add` + `commit --only`, hooks disabled via `-c`, fail-closed state in an unexported WeakMap, decisions on the structured `ok` field.
- **MCP posture.** Default-disabled, empty allowlist never connects, refusal re-checked at plan time before every spawn, `mcp_` prefix prevents shadowing `run_tests`/`git_commit`, child stderr drained without logging, solid loopback URL check.
- **Gateway hygiene.** Per-conversation promise chain swallows errors so one bad run can't poison the queue; bounded histories; webhook auth precedes the body read; secrets never logged; bot-loop prevention on Telegram and Discord; Telegram offset advances past poison messages; missing credentials degrade to idle adapters.
- **CLI.** `lich update` builds argv from constants with no shell and regex-validates the registry version; config creation uses `wx`; unknown flags fail closed; the wizard writes nothing on Ctrl+C.
- **Release script.** `execFileSync` with no shell, never publishes, checks clean tree (incl. untracked) and branch first, verifies the bump strictly increases.
- **Tooling.** `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`; a narrow `bun_api.d.ts` instead of global `@types/bun`.
- **Honest design docs.** `docs/design/self-improvement-loop.md` states the terminal floor and plugin-trust floor plainly; the README should match that candor.

## Unrelated observations (not changed)

- `.cursor/plans/lich_ai_harness_f1aee01b.plan.md` is tracked in git.
- `CLAUDE.md` is listed in `.gitignore`.
- `src/gateway/format.ts` `split_text` is only exercised by tests; production uses a duplicate in `telegram.ts`, and the usage-footer branch of `format_agent_reply` is never called.
