---
source_url: https://github.com/Moikapy/lich/issues/113#issuecomment-5835443032
ingested: 2026-09-25
sha256: 28e2fe5e83a70887c6948dcc82cda9a31bf8a86e58dc2fb7cb233f86999864ea
---
## Addendum 5: idea-agnostic harness — win on user control (plugins & tools)

This follow-up **reframes product identity**. It does not replace the gap list in §1, the Runtime / Profile / Session split, or the six-phase sequence. It **supersedes Addendum 4’s framing** of “four co-equal goals” with a clearer north star: Lich is a **domain-agnostic agent harness**. Verticals (games, content, coding, …) are proofs of extensibility, not the product’s definition.

### North star

Build the best agent we can — competitive with Cursor, Claude (Code), Hermes, Codex, OpenClaw and peers — by maximizing **user control** over how the agent behaves and what it can do:

- custom **plugins** and **tools** (first-party and user-authored)
- **MCP** and external skill/tool surfaces
- **Profiles** / identity (prompts, model routes, toolsets, budgets) the user owns
- local config and session state the user can inspect and improve

The power of Lich is not a baked-in “game mode” or “YouTube mode.” It is that a user can continuously **improve their own experience** without waiting on us to ship their vertical.

### How this relates to Addendum 4 (and A/B/C)

Addendum 4 added **(D) Create content** beside code / play / live-in games. That still matters as **dogfood and examples**:

| Vertical | Role under this addendum |
| --- | --- |
| Games (A/B/C) | Important proofs — real-time, multimodal, multi-agent stress tests |
| Content (D) | Important proofs — vision, long sessions, asset pipelines, brand memory |
| Coding / general agency | Default posture — same harness Cursor-class tools compete in |

Agents reading this plan must optimize for a **great general agent + a powerful extension model**. They must **not** treat Godot, Shorts, or any single vertical as the definition of done.

### What “best” means here (control > captive UX)

We compete where users can deepen the system:

1. **Tool and plugin authorship** is first-class (docs, schemas, safe defaults, discoverability).
2. **Toolsets are named and selectable per Profile** (Hermes-style), not one flat allowlist forever.
3. **Hooks and config fail closed where safety matters**, but stay **overrideable** where the user is deliberately extending power.
4. **One protocol / one runtime** (serve + in-process Agent) so every surface sees the same agent — extensions don’t fork behaviour per UI.
5. **No idea lock-in** in the default system prompt or product docs: myth/theme stay display-only; behaviour stays a plain harness.

Games and content keep informing latency, multimodal, and safety profiles; they do not own the roadmap’s identity.

### Implications for sequencing (no phase reorder)

- Phases 1–5 (envelope, gateway/SessionManager, interactive serve, real-time loop, memory/skills) remain the path to a serious general agent.
- Phase 6 multimodal still unlocks both play **and** content — and any other vision-heavy vertical users invent via tools.
- #117 (global `~/.lich` identity / profiles) and plugin/tool UX rise in importance relative to engine-specific SDKs.
- #114 item 11 (media toolchains) stays deferred as **optional vertical tooling**, not core identity work.

### Docs / wiki follow-through

- Decision [[0007-content-as-fourth-goal]] is updated: content/games are verticals under an idea-agnostic harness (this addendum).
- SCHEMA / roadmap map state the north star explicitly.

### Open questions (not blocking)

1. What is the smallest “extension excellence” milestone that feels better than Hermes/Cursor for power users (e.g. profile-scoped toolsets + one-page plugin author guide)?
2. Should default Profiles ship as examples (coding, studio, embedded-game) with empty/custom as the true default?
3. Where do we draw the line between first-party tools and “bring your own MCP” for competing with IDE agents?
