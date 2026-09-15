# Council Review — Simplicity & Value

Reviewer: Council Member 2 (Simplicity / YAGNI / Value) — review of `docs/design/self-improvement-loop.md` v1.

## Verdict

APPROVE-WITH-CHANGES — The valuable core (implement → `run_tests` → gated `git_commit`) is small and rides on machinery that already exists. But the plan ships a parallel skills subsystem (three rebadged docs tools), an unrequested LLM consolidation pipeline, a redundant `repo_status`, and four milestones for a one-maintainer feature — cut about two-thirds of it.

## Blocking findings

1. **Skills are docs rebadged (M2) — high.** `skill_search`/`skill_read` are `docs_search`/`docs_read` (`src/tools/builtin/docs_search.ts`, `docs_read.ts`) pointed at a second directory, and `skill_save` adds hand-rolled YAML frontmatter validation for metadata (`version`, `source_run`) nothing consumes in v1. The docs resolver is already a swappable seam (`set_docs_root_resolver` in `docs_read.ts`, built for tests); teaching it a second root like `.lich/skills` is ~10 lines. Simpler: **skills are `.md` files under `.lich/skills/`**, searchable/read by the existing tools, written by the agent with `write_file` (which already mkdirs parents — `src/tools/builtin/write_file.ts`). Zero new tools; a `# title` + date line is data enough, no frontmatter validator to maintain.

2. **LLM consolidation pass is auto-ML nobody asked for — high.** The reflector's every-N-runs ChatFn curation (plan §5) buys a second LLM call path, an N-run counter with unspecified persistence (in-memory state silently resets on restart), an unbounded `candidates.md` lifecycle, and a plugin that silently writes skill files — contradicting the plan's own "propose, don't ship". The simplest loop-closer: the agent appends one dated lesson line to `.lich/memory/MEMORY.md` itself as the last step of a self-improvement run (200-line cap, oldest dropped — a tiny append helper, no tool needed). Curation = the human deletes stale lines, or an explicit user-invoked "tidy memory" prompt later. No background pass, no counter, no Q4.

3. **`repo_status` is `terminal git status` in a costume — medium.** `terminal` is already core (`src/tools/builtin/index.ts`). A dedicated tool is schema + tests + docs for zero capability delta, and nothing gates on it (unlike `run_tests`). Cut it; document a one-recipe git workflow in the guide.

4. **`git_commit` earns its place — say why, then keep it — medium.** Vetoing free-form `terminal git commit/push` strings is brittle pattern-matching the agent can dodge (quoting, alternate paths); a named tool is the one stable choke point a `before_tool_call` veto can enforce (`src/plugins/hooks.ts`). So the gatekeeper is fine as specified — it is a plain consumer of the documented hook semantics (`docs/user-guide/plugins.md`) and serves the safety mandate. This is the single defensible new tool; everything else is optional.

5. **Four milestones for a solo maintainer — medium.** Only M4 proves the claim "Lich codes Lich"; M1–M3 are merely its parts. Three intermediate releases is process overhead on a repo at `0.3.0` with one `test` script (`package.json`). Ship one release whose acceptance test *is* the M4 e2e.

## Non-blocking observations

- Token economics: injecting MEMORY.md into the system prompt every run (plan §4) taxes every trivial run to save the agent one `docs_search`. Keep memory a plain searchable file, loaded on demand — zero plumbing.
- `run_tests` keeps structured `{passed, total, failures[]}`: it is the machine-checkable gate signal; parsing terminal transcripts is not. (Adversarial tension: green-tests-only gating can push the agent to delete failing tests — the human commit review is the real control; say so in docs.)
- Conventions: only the consolidation prompt-parsing + plugin-writes-skill-files design strains the 60-line hook rule; everything in the minimal version fits. Existing code is compliant (docs walker is iterative, `docs_read.ts`).
- If skills join the docs tools, the single-slot section cache in `docs_search.ts` (keyed on one root) must key per-root — a few lines, note it in the resolver change.
- Hidden-cost inventory otherwise checks out: no new dependencies, no recursion, `test_command` default matches the `package.json` test script.

## Answers to the plan's open questions

- **Q1:** Restrict `run_tests` to `work_dir` in v1; cross-repo runs are `terminal` territory.
- **Q2:** Explicit search only. Description-match auto-loading is speculative ranking machinery.
- **Q3:** 1 is right for "propose, don't ship" — and don't make it configurable; hardcode until proven wrong.
- **Q4:** Moot — cut consolidation. If it ever returns, main provider chain; a second config slot is YAGNI.
- **Q5:** YAGNI. A `created` date line suffices; drop `version` and `source_run`.

## Proposed minimal version

Smallest subset that still achieves "Lich codes Lich":

- **Tools (2):** `run_tests` (structured pass/fail + failing names, timeout, config `test_command`), `git_commit` (stages named paths, never pushes).
- **Plugins (1):** gatekeeper — veto `git_commit` without an in-run green `run_tests`, max 1 commit/run, `allow_self_commit: false` default. No reflector plugin.
- **Skills (0 tools):** `.lich/skills/*.md` written with `write_file`, found via existing docs search/read after the ~10-line second-root resolver extension.
- **Memory (0 tools, 0 plugins):** agent appends dated lines to `.lich/memory/MEMORY.md` via `write_file`/`edit_file`; 200-line cap in the tiny helper. No system-prompt injection.
- **Milestone (1):** the M4 e2e ("add `hash_text` to yourself" → read docs → write tool → tests green → gated commit) as the single release's acceptance test, plus a self-improvement guide in `docs/` — the guide *is* the first skill.