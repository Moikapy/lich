---
title: "0008: Idea-agnostic harness — win on user control"
created: 2026-09-25
updated: 2026-09-25
type: decision
tags: [decision, roadmap, process, plugins, tools, content, games]
sources: ["#113", "raw/issues/2026-09-25-issue-113-addendum-5-idea-agnostic.md"]
status: accepted
issue: "#113"
revisit_when: "When shipping the first extension-excellence milestone (profile-scoped toolsets + plugin author guide), or if a vertical (games/content) starts driving core API shape against general-agent needs"
---

# 0008: Idea-agnostic harness — win on user control

## Context

[[roadmap-issues]] (#113) started as a games audit (code / play / live-in). [[0007-content-as-fourth-goal]] widened that to include content creation. The maintainer’s sharper north star: Lich should be **idea-agnostic** and compete with Cursor, Claude, Hermes, Codex, OpenClaw and peers by giving users **more control** — custom plugins, tools, MCP, and profiles they can improve themselves — not by being “the game agent” or “the YouTube agent.”

## Decision

Accept **#113 Addendum 5**:

- **Product identity:** a domain-agnostic agent harness. Verticals (games, content, coding, …) are **proofs and dogfood**, not the definition of done.
- **Compete on controllability:** plugin/tool authorship, named toolsets per Profile, MCP, user-owned identity/config (#117), one runtime/protocol so extensions don’t fork behaviour per UI.
- **No idea lock-in** in default prompts or product behaviour (themes stay display-only).
- [[0007-content-as-fourth-goal]] remains true as a **vertical**: content (and games A/B/C) still matter; they no longer co-define the product as four equal “goals.” Media toolchains stay #114 item 11 (optional vertical tooling).

## Consequences

- Roadmap and agents prioritize a great general agent + extension model over engine- or channel-specific features.
- Games and content still inform latency, multimodal, and safety profiles ([[embedded-safety-profile]] for in-game; studio/dev profiles for content/coding).
- Plugin/tool UX and #117 rise relative to SDKs that only serve one vertical.
- Default system prompt and docs stay harness-shaped, not vertical-shaped.

## Alternatives considered

- **Four co-equal goals (A–D) as product identity.** Rejected as the top framing: useful as examples, but steers agents to vertical checklists instead of harness excellence (Addendum 5 supersedes that framing).
- **Ship as an IDE-only coding agent.** Rejected: leaves serve/Ossuary/game/content surfaces as second-class; loses the “one protocol” bet ([[0001-gateway-as-hub]]).
- **Win by bundling more first-party vertical tools than competitors.** Rejected as the primary strategy: user-authored tools/plugins scale better than us owning every idea.

Related: [[0007-content-as-fourth-goal]], [[runtime-profile-session]], [[lich-plugins-and-hooks]], [[lich-tools-and-guardrails]], [[lich-vs-hermes]].
