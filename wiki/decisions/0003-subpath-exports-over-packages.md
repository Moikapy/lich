---
title: "0003: Subpath exports + lint-enforced layers instead of separate packages"
created: 2026-09-23
updated: 2026-09-23
type: decision
tags: [decision, core, runtime, ecosystem]
sources: [raw/issues/issue-113.md, raw/issues/issue-114.md, raw/audits/2026-09-23-core-engine-audit.md]
status: proposed
issue: "#113"
revisit_when: "Any #114 item-1 trigger: independent core cadence, measured bundle-size problem, independent maintainers, or SDK/Ossuary version pinning"
---

# 0003: Subpath exports over packages

## Context

- The owner wants people to be able to "build with what they need from our ecosystem".
- Today one package ships everything. `ink` and `react` are hard dependencies of the *library*, and there is no `exports` map (C-7).
- The core imports surface code: `agent/config.ts` imports `gateway/access` and `gateway/token_env`, and `terminal.ts` imports `gateway/token_env`. ^[raw/audits/2026-09-23-core-engine-audit.md]
- The codebase is about 8k lines with a small team. The release script alone has already needed several fix PRs.

## Decision

Keep **one package** and expose its layers through `exports` (#113 Addendum 2 §B):

- `.`: Runtime, Profile and Session
- `./core`: the loop, content types and events, with no fs or Node imports, so it works in a browser
- `./gateway`
- `./tui`

Supporting rules:
- `ink` and `react` become **optional peer dependencies**, used only by `./tui`.
- Layers are enforced with **lint in CI** (dependency-cruiser or ESLint `no-restricted-imports`): core must not import runtime or any surface.
- These extension interfaces are **stable and covered by semver**: `Tool`, `Provider`, `Plugin` hooks, `Adapter`, `MemoryStore`, `Profile`.
- Engine SDKs are separate packages by nature, because they are other languages. Generate them from the protocol schema.

## Consequences

- A web game can import `./core` without pulling in the TUI stack.
- One version, one changelog, one release.
- What makes the ecosystem is its documented extension points, not the number of packages.
- The core ↔ surface imports must be untangled before the lint rule can pass. See [[runtime-profile-session]].

## Alternatives considered

- **A monorepo with separate npm packages now** (`@lich/core`, `@lich/runtime`, `@lich/cli`). Rejected for now: version skew, a larger public API to keep stable, more release tooling, more docs. See [[subpaths-vs-packages]].
- **Leave things as they are.** Rejected: the library keeps pulling in React, and the layers keep blurring.

## Revisit when

Any of the triggers in #114 item 1:
- core needs its own release cadence
- the bundle size of the single package is a measured problem for a web game
- outside maintainers own a layer
- Ossuary or the SDKs need to pin different core versions

Related: [[0004-dry-policy]], [[lich-agent-loop]].
