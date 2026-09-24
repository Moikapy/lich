---
title: Hermes Agent (Nous Research)
created: 2026-09-23
updated: 2026-09-23
type: entity
tags: [hermes, research, ecosystem]
sources: [raw/audits/2026-09-23-hermes-vs-lich.md]
confidence: high
---

# Hermes Agent

Hermes is the open-source Python agent that inspired Lich. It is installed locally at `~/.hermes/hermes-agent`, with the checkout's HEAD dated 2026-09-22.
- **Docs:** `website/docs/developer-guide/*.md` and the `AGENTS.md` file in each area.
- **Not docs:** `~/hermes` is empty, and `~/code/lich-hermes-docs` is an old Lich checkout (v0.7.0), not Hermes documentation.

## Code layout

Hermes pairs each facade with sibling files:
- `X.py` is the public face.
- `X_<topic>.py` files each own one topic.
- The agent loop is split into about 35 `agent/turn_*.py` phase files.

## Mechanisms worth studying

Details and file paths are in ^[raw/audits/2026-09-23-hermes-vs-lich.md].

- **A byte-stable system prompt with three tiers, plus 4 `cache_control` breakpoints.** See [[prompt-cache-tiers]].
- **Bounded `MEMORY.md` and `USER.md`** frozen into the prompt at session start, with **progressive disclosure** for skills (index in the prompt, `skill_view` on demand). See [[memory-vs-skills]].
- **Background review:** a forked agent that saves skills and memories every N turns. A **curator** archives stale skills.
- **SQLite with FTS5** and a `session_search` tool.
- **`delegate_task`:** depth 1, parallel batches, a list of blocked tools, and only a summary returned to the parent.
- **Named toolsets** with `check_fn` gating, resolved per session.
- **Approvals:** by pattern, by a human, or by an LLM; yolo mode; the gateway waits for the user's reply.
- **Interrupts per thread,** plus steer and redirect.
- **The gateway owns sessions and cron ticks.** This is the model for [[0001-gateway-as-hub]].
- **Trajectory output** (ShareGPT JSONL), `batch_runner.py`, **computer use** and **vision**.

## History note

The Atropos RL `environments/` directory was **removed** on 2026-05-15 in commit `5af672c753` (#26106). The old code is still useful as a reference when designing `lich env`: `git show 5af672c753^:environments/hermes_base_env.py`.

Related: [[lich-vs-hermes]], [[llm-wiki-pattern]] (Hermes ships an `llm-wiki` skill).
