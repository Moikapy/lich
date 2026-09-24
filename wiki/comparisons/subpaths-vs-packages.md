---
title: Subpath exports vs separate npm packages
created: 2026-09-23
updated: 2026-09-23
type: comparison
tags: [core, runtime, surface, ecosystem]
sources: [raw/issues/issue-113.md, raw/issues/issue-114.md, raw/audits/2026-09-23-core-engine-audit.md]
confidence: high
---

# Subpath exports vs separate packages

**Question:** how should Lich become modular enough that people can take only what they need, without taking on overhead the project can't afford? The source base is about 8k lines with a small team.

**The layering problem today:**
- Core imports surfaces: `src/agent/config.ts:6-8@77bc148` imports `gateway/access`, `gateway/token_env` and `mcp/mcp_pin`.
- `src/session/recorder.ts:6@77bc148` imports `agent/loop` in the wrong direction.
- `ink` and `react` are hard dependencies of the library.
- There is no `exports` map.

^[raw/audits/2026-09-23-core-engine-audit.md]

## Options

| | One package + subpath exports | Separate npm packages (`@lich/core`, `@lich/runtime`…) |
|---|---|---|
| Consumers import only what they need | yes (`@moikapy/lich/core`, `/gateway`, `/tui`) | yes |
| Avoiding `ink`/`react` | optional `peerDependencies` | natural |
| Versioning | one version, one changelog, one release | version skew across packages; needs changesets or similar |
| Public API surface | the documented extension interfaces only | every cross-package type becomes public API |
| Tooling | current `tsup` build + an `exports` map | workspace, multi-package release (the release script already needed several fix PRs) |
| Enforcing boundaries | lint (`dependency-cruiser` / ESLint `no-restricted-imports`) in CI | the package graph enforces it |
| Contributor overhead | low | higher: harder to find your way around, more docs |

**Decision:** subpath exports now, with layers enforced by lint. See [[0003-subpath-exports-over-packages]]. ^[raw/issues/issue-113.md]

```jsonc
"exports": {
  ".":         "./dist/index.js",    // Runtime, Profile, Session
  "./core":    "./dist/core.js",     // loop, message types, events (browser-safe)
  "./gateway": "./dist/gateway.js",
  "./tui":     "./dist/tui.js"
}
```

## What actually makes the ecosystem

These extension interfaces, documented, stable and covered by semver, matter more than how many packages there are:
- `Tool`
- `Provider`
- `Plugin` hooks
- `Adapter`
- `MemoryStore`
- `Profile`

A third party writing a Unity adapter or a memory backend against a stable interface benefits more than they would from ten `@lich/*` packages.

**The exception:** engine SDKs (GDScript, C#, Unreal C++) are separate packages by nature, because they are different languages. They should be generated from the serve protocol's JSON Schema ([[lich-serve]]).

## When to revisit a real package split

From #114, item 1. Split only if one of these holds: ^[raw/issues/issue-114.md]
- a consumer needs `core` on a different release cadence
- the single package's size or dependency footprint is a measured problem for a web game
- outside contributors maintain a layer independently
- Ossuary or the SDKs need to pin different versions of core

**Prerequisite:** the subpath layers and lint boundaries are already in CI.

Related: [[0004-dry-policy]], [[runtime-profile-session]].
