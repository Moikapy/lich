---
title: Ossuary (desktop app)
created: 2026-09-23
updated: 2026-09-25
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

Every pane renders from serve `event` notifications. #134 landed the [[event-envelope]]; Ossuary's wire parse keeps payload switches on `type` and accepts optional `run_id` / `session_id` / `seq` / `ts` (`apps/ossuary/src/chat/parse_wire_event.ts`). Gateway adapter migration of SessionManager remains on #114.

The Ossuary client depends only on the method names from #80, which are stable, so the gateway-hub plan does not block it ([[0001-gateway-as-hub]]).

Related: [[hermes-agent]] (Hermes' own `apps/desktop/` and `ui-tui` ↔ `tui_gateway` split).
