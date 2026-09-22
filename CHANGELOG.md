# Changelog

## 0.8.0 (unreleased)

- TUI session resume (Phase 1): `lich --resume <id|latest>` loads an existing
  JSONL transcript into the TUI history and shows a `resumed <id> (n messages)`
  banner. One-shot, chat, and gateway reject `--resume`.
- Incremental session persistence (Phase 2): Agent appends transcript records
  as the loop emits (`llm_end`, `tool_call_end`, `budget_exhausted`,
  `compress_end`) instead of a post-run bulk write. TUI opens one
  `SessionHandle` per launch and passes it into every `agent.run`; one-shot,
  chat, and gateway keep per-run files. Append failures warn and never fail
  the run.

## 0.7.1

- close agent-core review must-fixes A-1–A-4: multi-turn runs stop
  duplicating history, tool pairs survive compression and gateway history
  caps, and a mid-call abort becomes `stopped_reason: aborted` with the
  abort signal reaching in-flight tools.
- harden the webhook gateway (G-1/G-2/G-3/G-5): binds to loopback by
  default and requires a token when exposed, defaults public platforms
  (telegram/discord/twitch) to deny with a configurable allowlist plus a
  reduced safe toolset, catches telegram/discord reply send failures
  instead of crashing the run, and forces `platform=webhook` on the HTTP
  adapter.
- close MCP exit (M-1), empty Anthropic text, and env provider fallback:
  one-shot/chat/TUI/gateway runs call `Agent.close()` so stdio MCP
  sessions release; node children are still `unref`'d so the event loop
  can drain (bun keeps the child attached — see below). an empty
  Anthropic text block no longer 400s the session permanently, and
  mcp-only project configs no longer shadow `LICH_MODEL` / env providers.
- close tools must-fixes S-1–S-5: file writes/edits resolve realpath so
  symlink escapes are confined, `fetch_url`/`http_request` block private
  and loopback URLs, `.lich/config.json` and `.env` are forbidden write
  targets, terminal child env is scrubbed of provider secrets, and
  dash-leading `run_tests` filters are rejected so they cannot open the
  commit gate. `http_request` also strips IPv6 brackets before SSRF IP
  classification so `[::1]` literals are not skipped, and asserts headers
  through `Headers` after the `safe_fetch` merge.
- isolate usage per run (A-5) and memoize MCP attach (A-6): concurrent
  `Agent.run` calls no longer mix `usage_total`, and attach races can
  neither skip nor permanently fail.
- TUI: ignore message submit while a run is in flight (U-1), and walk the
  newest-first recall ring so Up moves to older entries instead of
  clamping on the newest (U-2).
- pin outbound HTTP: `fetch_url` and `http_request` keep the https
  hostname for TLS/SNI and the `Host` header while `safe_fetch` pins the
  connect to a vetted public IP through a custom DNS `lookup`, and
  re-validates every redirect hop. the operator opt-out is exact:
  `LICH_ALLOW_PRIVATE_URLS=1`; unset or any other value is fail-closed
  (private/loopback URLs blocked).
- harden `grep_files`: the directory walk skips symbolic links (same
  skip path as `SKIP_DIRS`), and every candidate read runs
  `assert_file_tool_access`, so `.lich/config.json` is denied with
  `forbidden_path: .lich/config.json`.
- twitch gateway: `PRIVMSG` matching is anchored (`^:... PRIVMSG #...
  :...$` after the optional tags strip), so `USERNOTICE` and
  `WHISPER` lines are not chat and cannot spoof the allowlist.
- bun stdio MCP children are no longer `unref`'d: one-shot and
  short-lived runs wait for the MCP answer instead of letting the child
  detach and exit early.
- add CI (tsc + vitest on Node 20/22), sync the 0.7.0 user docs with this
  tree, and make `edit_file` treat `$` sequences literally while allowing
  an empty `new_string` (#57).
- sync docs/architecture with the outbound-HTTP pin, grep hardening,
  twitch anchor, and bun MCP exit changes (#61).
- add a manual Release workflow: Actions → Release → Run workflow (from
  `main`) with a `patch|minor|major` bump runs `bun release`, then
  publishes the packed tarball to npm with `NPM_TOKEN`. maintainer
  plumbing, not a runtime change (#62).

## 0.7.0

- add a general MCP client. `mcp_servers` is a closed record of named
  stdio or loopback-http entries, default off. tool names are
  `mcp_<server>_<tool>`. `tools_enabled: []` drops them. the commander
  persona does not copy `mcp_servers`. redot is a catalog entry (local
  `redot` binary, `--headless --mcp-server --path <project>`, five
  upstream controllers, no execute). godot has no official server; lich
  does not download a community addon. play stays the webhook and
  game_bridge, the opposite direction. see docs/user-guide/redot.md.
- add `lich mcp` to list, add, enable, disable, and remove servers.
  add uses the catalog or `--command`/`--url`, stays disabled, and
  updates `.lich/config.json` through the existing writer without
  dropping other keys.
- sync user docs with this tree. MCP is included in the 0.7.0 package.

## 0.6.0

- document a per-persona orchestrator example: one agent per NPC, the
  webhook `POST /message` shape, and history serialization the game repo
  copies. lich does not ship the service. see
  examples/persona_orchestrator.
- document session JSONL as a combat log, with jq recipes for rationale,
  ability use, vetoes, rejects, and `run_end` token totals. see
  docs/user-guide/games.md.
- append a `run_end` meta record (`stopped_reason`, `usage`) on every
  completed run so token spend is in the transcript. `budget_exhausted`
  is still written when the stop reason is budget.
- add a display-only undead theme: frozen `lich` strings, `theme` / `--theme`, and `~/.lich/themes/<name>.json` that falls back to the built-in theme when missing or invalid.

## 0.5.1

- fix the CLI so bun's global bin enters main (symlink argv no longer skips the entry).
- read LICH_VERSION from package.json so lich --version is not stuck at 0.3.0.

## 0.5.0

- add a `game_bridge` example plugin that queues batched enemy actions
  and durable dungeon memory under `.lich/game/` for a Godot combat tick.
  a `before_tool_call` hook holds meteor until round 3. node loads the
  `.mjs` entry from `config.plugins`.
- load `config.plugins` on every CLI entry point and on `run_agent`
  (`create_agent_with_plugins`). one-shot, chat, tui, and the gateway
  bus no longer ignore plugin entries. broken plugins still warn and
  continue. `create_agent` stays plugin-free.
- bare `lich` opens the TUI. On a TTY, when no config is in the search
  chain and `LICH_MODEL` is unset, a readline wizard collects agent name,
  provider, gateway env-var names (never secrets), and plugins, then
  writes `.lich/config.json` once. Non-TTY stdin skips the wizard and
  prints guidance. `lich init` writes the starter file through the same
  writer and never overwrites an existing `.lich/config.json`.
- add `lich update`: compare the installed version with `npm view
  @moikapy/lich version` and, when newer, run
  `npm install -g @moikapy/lich@latest`. git clones are told to
  `git pull`; npx cannot persist an update.
- document embedding that plugin beside a Godot game: one webhook call
  per combat round, and the `.lich/game/` drain tick. see
  docs/user-guide/godot.md.

## 0.4.0

- add a self-improvement loop: `run_tests`, a gatekeeper plugin, and
  `git_commit` (one commit per run, never pushes). `git_commit` is
  registered by the gatekeeper, not the builtin tool list.
- fail-closed unless `LICH_ALLOW_SELF_COMMIT=1` at startup; unset or any
  other value vetoes `git_commit`. a commit also needs a green `run_tests`
  on a tree with no later `write_file`/`edit_file`.
- `run_tests` runs `LICH_TEST_COMMAND` in `work_dir` (default vitest) and
  appends an optional filter as a quoted shell token.
- `docs_search` finds markdown skills under `.lich/skills` (fresh walk, no
  `index.md` gate). `MEMORY.md` is never auto-loaded.
- close gatekeeper fail-open holes: git spawned with `hooksPath=/dev/null`,
  pathspec magic rejected, denylist matches `commit-tree`/`update-ref` on
  any occurrence, abort SIGKILLs the git child.
- honor per-tool `timeout_ms` (terminal is 5 min) instead of a flat 30s
  executor budget.

## 0.3.1

- Fix: published CLI bin now works — `dist/cli.js` shipped without its
  `#!/usr/bin/env node` shebang, so the `lich` command failed after npm
  install; shebang restored (5d7d9c9).
- Fix: TUI header showed a stale hardcoded version; now reads LICH_VERSION
  to match the package.
- Docs: npm install is the primary usage path (package now published);
  new Updating section in getting-started; docs-site fixes (dead links,
  vitepress base for the pages subpath).
- Tests: suite passes under both vitest and `bun test`
  (runner-independent stubs); portable fixtures — no more NAS-hardcoded
  paths.
- Dev: `bun release patch|minor|major` release pipeline
  (scripts/release.ts) — version bump, pack, and audit.

## 0.3.0

- Plugin system (v0.3.0): load user-authored tools and lifecycle hooks from
  explicit module paths (`plugins` config array). Hooks cover
  `before_tool_call` (veto with `blocked_by_plugin`), `after_tool_call`,
  `on_run_start`, and `on_run_end`; broken plugins warn and are skipped.
  New API: `create_agent_with_plugins`, `load_plugins`, `HookedToolRunner`,
  `Plugin`/`PluginHooks`/`LoadedPlugin` types. Docs:
  docs/user-guide/plugins.md, docs/architecture/plugins.md.

## 0.2.0

- Gateway: route Telegram, Discord, Twitch, and a zero-config webhook HTTP
  endpoint into one shared agent with per-conversation memory (webhook serves
  `POST /message` + `GET /health`, optional `x-lich-token` auth).
- Ink terminal UI: `lich tui` with live transcript (tool-call rows), status
  bar (model/turns/tokens), slash commands, and input history recall.
- Six new builtin tools: `fetch_url`, `web_search`, `http_request`,
  `process_list`, `disk_usage`, `env_get` (12 builtins total).
- Multi-turn history API: `AgentRunOptions.history` + `AgentRunResult.messages`.
- Ollama provider (local + cloud, optional bearer auth, `think`/`keep_alive`).
- README: gateway + TUI documentation and the four CLI modes.