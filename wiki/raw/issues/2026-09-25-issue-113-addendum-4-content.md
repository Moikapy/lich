---
source_url: https://github.com/Moikapy/lich/issues/113#issuecomment-5835381303
ingested: 2026-09-25
sha256: d73094cea3714a9a0a4499894666e08ddabfb5043dfc71a234172abb17bba73b
---
## Addendum 4: content creation is a first-class goal (not only games)

This follow-up widens the **product framing** of the audit. It does **not** change the structural gap list in §1, the Runtime / Profile / Session split in §2b, or the six-phase sequencing (as revised by Addendum 1). Those capabilities are the shared substrate; this addendum names another vertical that uses them.

### Context

§0 framed three goals:

- **(A) Code games** — help build games in Godot, Redot, Unity, Unreal, …
- **(B) Play games** — act as a player in games, emulators, gyms
- **(C) Live inside games** — NPC brains, game masters, simulations

Games are an important vertical Lich will build toward. They are **not** the only intended use of the harness. The maintainer also wants Lich useful for **creating media content**: YouTube videos and Shorts, clipping, art direction / generation, and related edit pipelines.

### Decision

Add a fourth goal:

- **(D) Create content** — help invent, produce, and edit media (scripts, long-form video, Shorts, clips, thumbnails, still art, brand/series assets) with the same agent core used for games.

**Games remain one vertical among several.** Agents reading this plan must not optimize the roadmap *only* for Godot/NPC latency when the same harness work (streaming, content blocks + vision, profiles/toolsets, memory, serve/Ossuary) also unlocks content workflows.

### How (D) maps onto existing gaps (no new core features required)

| Content workflow | Already called for in this issue |
| --- | --- |
| Script → revise → caption / voiceover loops | Streaming (§1, §2c.2), action-terminal tools (§2c.5), Profiles + toolsets (§2b, Hermes parity) |
| Look at frames, thumbnails, comps, storyboards | Content blocks + vision (§1, §2c.3, phase 6) |
| Clip detect, ffmpeg, asset folders, export | Named toolsets + file/shell wards; optional computer-use / browser after content blocks (#114 item 9 adjacent) |
| Series voice, channel bible, recurring characters | Profiles + namespaced memory (§2b, §4 memory); related: #117 global `~/.lich` identity |
| Long edit sessions without losing state | Session / Runtime split, event envelope (§2b, §2c.1); Ossuary / serve as the control surface |

So (D) does **not** invent a second agent architecture. It demands we treat multimodal + tools + profiles as **horizontal** product requirements, with content-specific skills/MCP/tools layered on top (editors, generators, ffmpeg, brand kits, …).

### What this does *not* change

- Phase order (foundation → gateway → interactive adapter → real-time loop → memory/skills → multimodal) stays.
- Embedded / game-safe profiles stay required for (C); content work typically uses a **dev** or **studio** profile with broader tools, not the embedded preset.
- Deferred package split and play-harness items in #114 stay deferred; media **toolchains** (ffmpeg wrappers, clip pipelines, generator MCP) are parked there until content blocks land — see #114 item 11.

### Docs / wiki follow-through

- Record this as a decision in `wiki/decisions/` and update [[roadmap-issues]] / SCHEMA goal list so new sessions see four goals, not three.
- User-facing `docs/` stay behaviour-only; no new shipped guide in this addendum.

### Open questions (not blocking)

1. First content vertical to dogfood after content blocks: Shorts clipping, thumbnail/art, or long-form edit assist?
2. Should studio profiles live under #117 (`~/.lich/profiles`) alongside coding/game profiles?
3. Which external MCPs / CLIs are allowed by default in a studio toolset vs opt-in?
