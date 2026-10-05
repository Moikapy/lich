---
title: Wiki log
type: log
---

# Log

Append-only. One line per action: `- YYYY-MM-DD <op> | <summary> | <pages>`. Ops: `init`, `ingest`, `create`, `update`, `decide`, `query`, `lint`, `archive`.

- 2026-09-23 init | Wiki created (#113 Addendum 3): SCHEMA, README, index, log, lint script, lich-wiki skill | SCHEMA.md, README.md, index.md, scripts/lint.mjs
- 2026-09-23 ingest | Architecture audit reports (Hermes comparison, core engine, game surface), checked against origin v0.9.0 @bad1243 | raw/audits/*
- 2026-09-23 ingest | Issue snapshots #113 (+3 addenda), #114, #79 | raw/issues/*
- 2026-09-23 ingest | REVIEW.md and 13 untracked REVIEW-pr*-herdr.md files (copied; originals still in the repo root) | raw/reviews/*
- 2026-09-23 ingest | Karpathy LLM wiki summary and the Hermes llm-wiki skill | raw/external/*
- 2026-09-23 create | Entity pages for Lich subsystems, Hermes, engines, examples, roadmap map | entities/*
- 2026-09-23 create | Concept pages: TAO loop, action-terminal mode, client-executed tools, event envelope, runtime/profile/session, prompt-cache tiers, memory vs skills, NPC memory namespaces, streaming deltas, embedded safety profile, LLM wiki pattern | concepts/*
- 2026-09-23 create | Comparisons: lich-vs-hermes, game-transports, subpaths-vs-packages | comparisons/*
- 2026-09-23 decide | 0001–0006: gateway as hub, serve PR path, subpath exports, DRY policy, kanban + single-issue workflow, in-repo wiki | decisions/*
- 2026-09-23 query | Filed answers: build around the gateway, LLM wiki vs docs, project vs user skill | queries/*
- 2026-09-24 update | Re-pinned serve/Ossuary pages after #99–#103 and the Ossuary wave (#123) merged; decision 0002 revisit fired (envelope/SessionManager not done pre-merge, work now #114 item 2); kanban.sh audit PR-linkage + page-cap fixes with regression tests (PR #124 review) | entities/lich-serve.md, entities/ossuary.md, concepts/event-envelope.md, decisions/0002-serve-pr-merge-path.md, index.md
- 2026-09-24 update | Board hygiene: closed orphan Ossuary issues + epic #79 and duplicate #120; wiki map/index/entity wording matches #123 close-out | entities/ossuary.md, entities/roadmap-issues.md, index.md
- 2026-09-25 update | Closed REVIEW epic #46/#47; leftover T-3/T-4 depth parked as #114 item 10; roadmap map + kanban skill key-issues note | entities/roadmap-issues.md, index.md
- 2026-09-25 update | Worktree convention is now gitignored `.worktrees/issue-<N>-<slug>` (was `~/code/lich-wt-issue-*`) | queries/project-vs-user-skill.md
- 2026-09-25 decide | #113 Addendum 4: content creation is a fourth goal; #114 item 11 parks media toolchains | decisions/0007-content-as-fourth-goal.md, entities/roadmap-issues.md, SCHEMA.md, index.md
- 2026-09-25 decide | #113 Addendum 5: idea-agnostic harness wins on user control; 0007 superseded by 0008; verticals are dogfood | decisions/0008-idea-agnostic-extensible-harness.md, decisions/0007-content-as-fourth-goal.md, entities/roadmap-issues.md, SCHEMA.md, index.md
- 2026-09-25 update | #134 P1: event envelope + SessionManager landed in 0.10.0; serve per-session queues; Ossuary parse accepts envelope | concepts/event-envelope.md, entities/lich-serve.md, index.md
- 2026-10-02 update | Merged #143 #141 #139 #137 #127 #115 (test coverage) and #142 (gateway history cap keeps tool-heavy windows, stub user turn when none); no wiki page covers the cap yet | log.md
- 2026-10-02 ingest | Decision models (Jev, Clef) and Ollama model research from web-search summaries; primary pages blocked | raw/audits/2026-10-02-decision-models-ollama-research.md
- 2026-10-02 create | Decision models concept: typed calibrated decisions as an optional plugin fast lane with LLM fallback; filed #148 | concepts/decision-models.md, index.md
- 2026-10-02 update | Providers: Ollama Bearer auth already supports ollama.com cloud; README key note and llama3.2 default are stale (#148); action-terminal-mode links the decision-model fast lane | entities/lich-providers.md, concepts/action-terminal-mode.md
- 2026-10-02 ingest | Hermes upstream at bed0d535: per-task auxiliary models and fallback chain, memory-plugin embedders, 14 community Jev plugins and the host features they use | raw/audits/2026-10-02-hermes-models-memory-decisions.md
- 2026-10-02 update | Hermes model roles, memory and decision plugins; comparison rows for model roles, plugin settings, LLM-call hooks and decision models; decision models stay plugin-owned with shadow mode first; #148/#149 revised to match | entities/hermes-agent.md, comparisons/lich-vs-hermes.md, concepts/decision-models.md, entities/lich-plugins-and-hooks.md, index.md
- 2026-10-02 update | Fix Hermes Jev plugin count (15 dedicated plus 4 with Jev backends; raw source left as captured); providers page now reflects merged #152 (qwen3:8b default, Ollama cloud documented) | entities/hermes-agent.md, comparisons/lich-vs-hermes.md, entities/lich-providers.md
- 2026-10-03 ingest | Ollama System One and Cloudflare Clef from the ollama/ollama repo at 42e911bc: Clef in 0.35.1, local only, 2-26 criteria, clef-flash bug #18769 | raw/audits/2026-10-03-ollama-systemone-clef.md
- 2026-10-03 update | Decision models: correct Clef availability, local-only endpoint, option cap; plugin path now uses #157 host features | concepts/decision-models.md
- 2026-10-03 update | Model roles (#154) and plugin entries, settings, model access, before_llm_call (#157) pinned at 1567638; Hermes comparison rows marked done | entities/lich-providers.md, entities/lich-plugins-and-hooks.md, comparisons/lich-vs-hermes.md
- 2026-10-03 update | Index one-liners for providers and plugins match #154 and #157 | index.md
- 2026-10-04 create | decision_lane example merged in #159: plugin-owned System One client, shadow/act modes, game_bridge checks still apply, bench pending | entities/decision-lane-example.md, index.md
- 2026-10-04 update | Decision models and game_bridge pages link the decision_lane prototype | concepts/decision-models.md, entities/game-bridge-example.md
- 2026-10-04 update | #161 merged: tools_enabled filters plugin tools and git_commit, throwing before_tool_call blocks, last-turn tool calls not run; holes lists and index updated, code pinned at 029b7e8 | entities/lich-plugins-and-hooks.md, entities/lich-tools-and-guardrails.md, entities/lich-agent-loop.md, index.md
- 2026-10-04 update | #163 merged: S-11 items (http_request status, .. guard, terminal_timeout_ms) moved out of open holes, pinned at 7001e31 | entities/lich-tools-and-guardrails.md
- 2026-10-04 update | Roadmap map lists #113 children and related issues (#133 P0, #134 P1, #117 P2, #144, #148, #149); supersedes stale PR #135 | entities/roadmap-issues.md
- 2026-10-05 create | Config layers page after #170–#172: global < profile < project merge, writers, guard, and config profile vs runtime Profile; pinned at ab0f508 | entities/lich-config.md, index.md, SCHEMA.md (tag: config)
- 2026-10-05 update | Guardrails: file tools deny .lich/profiles (reads too) and list_dir/disk_usage skip it; runtime-profile-session notes the config-profile name clash; index providers line no longer claims duplicated helpers (#165) | entities/lich-tools-and-guardrails.md, concepts/runtime-profile-session.md, index.md
