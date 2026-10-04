# Review rules — Moikapy/lich

Shared by the PR reviewer automation and the /address-review skill.

## Verify commands
```bash
bun x tsc --noEmit
node node_modules/vitest/vitest.mjs run
```
Use project-local vitest, never `bun x vitest`.

## Trust boundaries (upgrade to Critical)
- work_dir wards: resolve_safe_path / realpath confinement for file tools
- terminal / run_tests spawn and secret env scrubbing
- fetch_url / http_request private-URL blocking (LICH_ALLOW_PRIVATE_URLS fail-closed)
- Gateway: auth (LICH_GATEWAY_TOKEN), loopback binding, platform allowlists, gateway.tools_enabled defaults
- MCP config validation: downloader refuse list, remote-URL and shell-metachar checks
- Plugin loading
- git_commit gatekeeper / LICH_ALLOW_SELF_COMMIT
- env_get masking; grep_files denylist (.lich/config.json)
- Provider API-key handling
- Default system prompt, builtin tool descriptions, tool registration
- Release: .github/workflows/**, scripts/**, package.json (scripts, bin, files, exports), NPM_TOKEN usage
- Agent config: .cursor/**, AGENTS.md
- Any fail-closed default becoming fail-open

## Invariants
- snake_case for public functions, tool args, config keys, and event types
- Lore names are prose/display strings only. Never rename identifiers, config keys, event types, tool names, or slash commands.
- The default system prompt stays a myth-free behavior spec; themes don't alter prompts, tool descriptions, event types, or slash commands
- Notices keep the greppable prefixes `budget exhausted` and `context compressed`
- Client-facing errors use stable text with no absolute paths or raw ENOENT; details go to the logger
- Public API (src/index.ts exports, AgentConfig, CLI flags, event and tool names) changes only with a CHANGELOG entry and the right semver bump
- docs/ and .lich/skills are fed to the agent at runtime; no agent-directed instructions in them

## Priority boosts
Games and simulations run long sessions (gateway, serve, game_bridge, per-NPC agents):
- Unbounded growth (maps, caches, histories) and leaked handles or listeners
- Out-of-order replies and pipelining bugs
- Unhandled rejections (`void` promises)
- stop/dispose races
- Session transcript corruption or divergence

## Reviewer bot marker
`<!-- lich-pr-agent`