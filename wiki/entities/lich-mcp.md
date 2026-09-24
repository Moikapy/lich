---
title: Lich MCP client and catalog
created: 2026-09-23
updated: 2026-09-23
type: entity
tags: [mcp, editor, engines, tools]
sources: [raw/audits/2026-09-23-core-engine-audit.md, raw/audits/2026-09-23-game-surface-audit.md]
confidence: high
---

# Lich MCP

`src/mcp/*` is an MCP **client**. It connects over stdio, or over HTTP to loopback only. It adds:
- pinning
- a refuse-list, which drops dangerous tools such as Redot's `execute`
- a catalog in `optional-mcps/`
- `lich mcp add/edit/list`

Tools are registered as `mcp_<server>_<tool>`, and connections are attached once per Agent.

## The editor side of coding games

- **Redot** is a real catalog entry (`redot --headless --mcp-server`). It exposes `scene_action`, `resource_action`, `code_intel`, `project_config` and `game_control`. See [[godot-and-redot]].
- **Godot** is `transport: "none"`, because Godot has no official MCP server.
- There are no Unity, Unreal or Bevy entries yet (#113 §4(A)).

## Organization

The client is 21 files of 40–60 lines each, and every file carries a redundant `mcp_` prefix. The plan is to consolidate them into about 5 files (`client`, `transport`, `catalog`, `register`, `safety`); see [[0004-dry-policy]].

## Open issues

- **M-10:** tool-name sanitizing can produce collisions (`mcp_names.ts`).
- **No server mode.** Hermes can run as an MCP server (`mcp_serve.py`), and Lich cannot. Deferred in #114, item 8.

Related: [[lich-tools-and-guardrails]], [[lich-vs-hermes]].
