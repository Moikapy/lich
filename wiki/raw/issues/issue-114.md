---
source_url: https://github.com/Moikapy/lich/issues/114
ingested: 2026-09-23
sha256: c0bd91fbe4426135313d53b53851c6caa40ae03310f104e409e71d28567d1ccc
---
# #114 Future: deferred architecture work & revisit triggers (from #113)

## Purpose

This issue parks work that came out of the architecture audit in #113 and was **deliberately deferred**. Each item says why it is deferred, what it depends on, and **when to revisit it**.

Rule of thumb: don't start an item until its "revisit when" condition is true. When it is, open a focused issue and tick the item here.

---

### 1. Split into separate npm packages
- **What:** Publish `@lich/core`, `@lich/runtime` (or keep `@moikapy/lich`), `@lich/gateway` and `@lich/cli` as separate packages in a workspace.
- **Why deferred:** One package with subpath exports and lint-enforced layers (#113 Addendum 2 §B) gives most of the benefit without version skew, the extra public API to keep stable, or the release tooling.
- **Revisit when any of these holds:**
  - A consumer needs `core` on a different release cadence.
  - Bundle size or dependency footprint of the single package is a measured problem for a web game.
  - Outside contributors maintain a layer independently.
  - Ossuary or the SDKs need to pin different versions of core.
- **Depends on:** stable subpath layers + lint boundaries in CI.

### 2. Move messaging adapters onto the shared SessionManager
- **What:** Rebuild telegram, discord, twitch and webhook as "text" adapters on the gateway core. That means SessionManager (from `bus.ts`), Profiles and Policy (from `access.ts`), and adapters that declare their capabilities.
- **Why deferred:** It is not needed to unblock serve or Ossuary. Only the SessionManager extraction happens now (#113 Addendum 2 §A).
- **Revisit when:** SessionManager is merged and used by serve, and gateway persistence (history survives a restart) or per-chat profiles are wanted.
- **Also fixes:** G-10 (`/start` rewrite, eviction by insertion order, shutdown not awaited); webhook `usage: null`; webhook returning HTTP 200 on agent errors.

### 3. Fold serve into the gateway as its "interactive" adapter
- **What:** `lich serve` becomes the WebSocket JSON-RPC adapter of the gateway hub. Add:
  - client-executed tools (`tool.invoke` / `tool.result`)
  - `text_delta` streaming
  - `deadline_ms` and fallback actions
  - protocol version and capabilities in `health`
  - a JSON Schema export
- **Revisit when:** Item 2 has landed, or serve's session and run code is already running on SessionManager.

### 4. Retire the file bus and the copy-paste examples
- **What:** Remove the `.lich/game/orders.jsonl` polling pattern from `examples/game_bridge`, and reduce `examples/persona_orchestrator` to a ~20-line Profiles + Sessions example.
- **Revisit when:** Client-executed tools exist (item 3) and the GDScript SDK sample project replaces the file bus.
- **Note:** Keep the file-bus docs until then. They are the only working Godot path today.

### 5. Engine SDKs beyond GDScript
- **What:** A C# SDK (Unity and Godot .NET), then an Unreal C++ plugin, generated from the protocol schema.
- **Revisit when:** The GDScript addon and sample have shipped and the protocol has a version number and has been stable for one release.

### 6. Non-loopback serve / TLS
- **What:** Bind serve beyond loopback with TLS and a real auth story, for dedicated servers and game masters on a LAN.
- **Revisit when:** Someone has a concrete deployment that can't use a reverse proxy.

### 7. Memory and learning follow-ups
- **What:**
  - embedding-based memory retrieval
  - Hermes-style background review, where a forked agent saves skills and memory every N turns
  - a skills curator (mark stale, archive)
  - session search over SQLite FTS5
- **Revisit when:** Namespaced memory plus the skills index, `skill_view` and `skill_manage` are merged and used by at least one game profile.
- **Prototype:** the in-repo project wiki (`wiki/`, #113 Addendum 3) uses the same layout (raw sources, entity and concept pages, index, log) that a shipped `MemoryStore` and a game lore wiki would use. Revisit its format once the wiki has run for about a month.

### 8. Platform features parked until there's a need
- [ ] Cron / world-tick scheduler in the gateway: when a sim needs scheduled agent runs.
- [ ] Docker (or other sandbox) terminal backend: when coding agents run on untrusted repos.
- [ ] MCP server mode (Lich *as* an MCP server): when an editor or another agent wants to call Lich.
- [ ] Shadow-git file checkpoints before edits: when Lich is used for longer autonomous edit sessions.
- [ ] Approval routing (`approval_required` to TUI or serve): after the interactive adapter exists.

### 9. Play-games harness extensions
- **What:** After the first version of `lich env` and `lich bench`:
  - PettingZoo / multi-agent environments
  - a desktop computer-use adapter
  - trajectory export for fine-tuning
- **Revisit when:** Content blocks with vision are in, and one Gymnasium or emulator adapter works end to end.
- **Reference:** Hermes's removed Atropos environments, `git show 5af672c753^:environments/hermes_base_env.py` in `~/.hermes/hermes-agent`.

---

### Not deferred (tracked in #113, do now)
- Merge #99 and #103 as they are.
- Extract SessionManager and add the event envelope before #101 and #102 merge.
- Subpath exports, `ink`/`react` as optional peer dependencies, lint layer boundaries.
- DRY items: `providers/http.ts`, `format_result`, `split_text`.
- Consolidate `src/mcp/`, move the flat `cli_*.ts` files into `cli/`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
