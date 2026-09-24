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
