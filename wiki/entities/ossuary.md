---
title: Ossuary (desktop app)
created: 2026-09-23
updated: 2026-09-24
type: entity
tags: [ossuary, surface, serve]
sources: [raw/issues/issue-79.md, raw/audits/2026-09-23-game-surface-audit.md]
confidence: medium
---

# Ossuary

Ossuary is a Hermes-shaped desktop app built with Electron, React and Dockview (epic #79, closed after #123). Its code lives in `apps/ossuary`. It is a client of [[lich-serve]], and the rule from #79 remains: "Do not build panels on webhook `POST /message`."

## Shipped tracks (issues #85–#94 via #123)

- Electron + React scaffold (#85)
- spawn `lich serve` and connect a WebSocket client (#86)
- a Chat pane (#87)
- a contribution registry for panes (#88)
- a Dockview shell (#89)
- tool_log and status panes (#90)
- a sessions pane (#91)
- persisted layout (#92)
- popout windows (#93)
- the `lich ossuary` CLI command and docs (#94)

## Coupling risk

Every pane renders from serve `event` notifications, and those carry raw `AgentEvent` values with no run or session id. [[0002-serve-pr-merge-path]] planned the [[event-envelope]] before #102 merged, but #101/#102 went in with the Ossuary wave (#123) without it — the panes already read a few payload fields (`apps/ossuary/src/chat/event_blocks.ts:6-20@db5c797`), so an envelope change now touches their parse path too. The remaining work is #114 item 2.

The Ossuary client depends only on the method names from #80, which are stable, so the gateway-hub plan does not block it ([[0001-gateway-as-hub]]).

Related: [[hermes-agent]] (Hermes' own `apps/desktop/` and `ui-tui` ↔ `tui_gateway` split).
