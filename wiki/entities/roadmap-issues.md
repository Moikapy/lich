---
title: Roadmap issues map
created: 2026-09-23
updated: 2026-09-25
type: entity
tags: [roadmap, process]
sources: [raw/issues/issue-113.md, raw/issues/issue-114.md, raw/issues/issue-79.md, "#113", "#133", "#134"]
confidence: high
---

# Roadmap issues map

This page is a **map of what each key issue is for**. It does not track status: status lives on the kanban (GitHub Project #2, [[0005-kanban-and-single-issue-workflow]]).

| Issue | Role | Wiki pages |
|---|---|---|
| **#113** | Plan of record / **phased epic**: idea-agnostic harness (Addendum 5). Children: #133 P0 hygiene, #134 P1 envelope+SessionManager; P2–P7 filed when started. Games/content are dogfood verticals. | [[0008-idea-agnostic-extensible-harness]], [[0001-gateway-as-hub]], [[event-envelope]] |
| **#114** | Deferred work with revisit triggers: package split, adapters, file-bus, SDKs, TLS, memory, platform features, play harness, REVIEW test depth (10), media toolchains as optional vertical tooling (11) | [[subpaths-vs-packages]], [[npc-memory-namespaces]], [[0008-idea-agnostic-extensible-harness]] |
| **#79** | Ossuary and serve epic (#80–#95). Closed after the wave landed in #123; remaining envelope/SessionManager follow-ups live under #114. | [[ossuary]], [[lich-serve]] |
| **#46 / #47** | v0.7.0 REVIEW epic and Tests & CI tracker — **closed**. Leftover T-3/T-4 depth is #114 item 10. | [[lich-tools-and-guardrails]] |

## Six phases (from #113 §6, revised by Addendum 1)

1. **Foundation:**
   - [[event-envelope]]
   - remove global state
   - [[runtime-profile-session]]
2. **Gateway core:** SessionManager, Profiles and Policy, adapters that declare their capabilities.
3. **Interactive adapter:**
   - serve folded into the gateway
   - [[client-executed-tools]]
   - [[streaming-deltas]]
   - deadlines
   - [[embedded-safety-profile]]
   - the GDScript SDK
4. **Real-time loop features:** `tool_choice`, [[action-terminal-mode]], parallel tools.
5. **Memory and skills:** [[memory-vs-skills]], [[prompt-cache-tiers]], delegation.
6. **Multimodal** (play, content, and other vision-heavy verticals), then the package split. North star: [[0008-idea-agnostic-extensible-harness]].
