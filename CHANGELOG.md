# Changelog

## Unreleased

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