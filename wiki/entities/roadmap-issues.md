---
title: Roadmap issues map
created: 2026-09-23
updated: 2026-09-25
type: entity
tags: [roadmap, process]
sources: [raw/issues/issue-113.md, raw/issues/issue-114.md, raw/issues/issue-79.md]
confidence: high
---

# Roadmap issues map

This page is a **map of what each key issue is for**. It does not track status: status lives on the kanban (GitHub Project #2, [[0005-kanban-and-single-issue-workflow]]).

| Issue | Role | Wiki pages |
|---|---|---|
| **#113** | Plan of record: the architecture and gap audit. Covers games (code, play, embed), parity with Hermes, reorganization, and the doc drafts. Addenda: 1 = gateway as hub, 2 = the serve PR path plus modularity and DRY, 3 = this wiki. | [[0001-gateway-as-hub]], [[0002-serve-pr-merge-path]], [[0003-subpath-exports-over-packages]], [[0004-dry-policy]], [[0006-in-repo-llm-wiki]] |
| **#114** | Deferred work, each item with a revisit trigger: package split, adapter migration, file-bus retirement, SDKs, TLS, memory follow-ups, parked platform features, play-harness extensions, and remaining REVIEW test depth (item 10 from #46) | [[subpaths-vs-packages]], [[npc-memory-namespaces]] |
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
6. **Multimodal and play,** then the package split.
