# Changelog

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