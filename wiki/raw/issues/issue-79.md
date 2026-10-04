---
source_url: https://github.com/Moikapy/lich/issues/79
ingested: 2026-09-23
sha256: d111d9fbce4fb1cbb740a4c26eb3bd64b202d837818688a9ce0d662c56779f4f
---
# #79 Ossuary: Hermes-shaped dockable desktop

## Summary

Post-0.9.0 work. Headless `lich serve` owns the Agent; `apps/ossuary` is Electron + React + Dockview. Session Phases 1–3 already on main. Issues 01–05 = serve; 06–15 = desktop. Do not build panels on webhook `POST /message`.

## Release gate

**Do not ship `lich serve` / ossuary in 0.9.0.** This epic tracks post-0.9.0 work. First post-release PR = Issue 01 (protocol types only).

## Tracks

This epic tracks **Issues 01–15** plus a companion Cursor Herdr delegate-rule update (docs via Lich, not Hermes).

| Column | Issues |
| --- | --- |
| Serve foundation | 01–05 |
| Desktop shell | 06–08 |
| Docking | 09–13 |
| Multi-window + ship | 14–15 |

Child issue links will be listed in a follow-up comment after filing.

---

## Comment by Moikapy (2026-09-22T23:22:00Z)

## Child issues (in plan order)

### Track A — `lich serve`
| # | Title |
| --- | --- |
| #80 | serve: define JSON-RPC protocol types and architecture note |
| #81 | serve: WebSocket JSON-RPC transport with health on loopback |
| #82 | serve: session.create / clear / list / resume with server-owned history |
| #83 | serve: prompt.submit / abort and AgentEvent notifications |
| #84 | cli: add lich serve subcommand |

### Track B — `apps/ossuary`
| # | Title |
| --- | --- |
| #85 | ossuary: scaffold apps/ossuary Electron + React hello window |
| #86 | ossuary: spawn lich serve and connect WS JSON-RPC client |
| #87 | ossuary: Chat pane end-to-end via serve |
| #88 | ossuary: contribution registry for panes |
| #89 | ossuary: Dockview shell hosting registered Chat pane |
| #90 | ossuary: tool_log and status first-party panes |
| #91 | ossuary: sessions pane via session.list + session.resume |
| #92 | ossuary: persist Dockview layout across restarts |
| #93 | ossuary: Dockview popout tear-out and re-dock spike |
| #94 | ossuary: lich ossuary command and user-guide docs |

### Companion
| # | Title |
| --- | --- |
| #95 | chore: update Cursor Herdr delegate rule — docs via Lich not Hermes |

**URLs**
- https://github.com/Moikapy/lich/issues/80
- https://github.com/Moikapy/lich/issues/81
- https://github.com/Moikapy/lich/issues/82
- https://github.com/Moikapy/lich/issues/83
- https://github.com/Moikapy/lich/issues/84
- https://github.com/Moikapy/lich/issues/85
- https://github.com/Moikapy/lich/issues/86
- https://github.com/Moikapy/lich/issues/87
- https://github.com/Moikapy/lich/issues/88
- https://github.com/Moikapy/lich/issues/89
- https://github.com/Moikapy/lich/issues/90
- https://github.com/Moikapy/lich/issues/91
- https://github.com/Moikapy/lich/issues/92
- https://github.com/Moikapy/lich/issues/93
- https://github.com/Moikapy/lich/issues/94
- https://github.com/Moikapy/lich/issues/95
