---
source_url: file://lich/REVIEW-pr74-herdr.md (untracked, copied 2026-09-23)
ingested: 2026-09-23
sha256: 36f8de51d88e05e05d46eb7bda53fe0e8d76711bceef50cd865a0932c531f2bd
---
# Review: PR #74 — fix(cli): C-4/C-5/C-6 provider kind, chat memory, update detect

Repo: Moikapy/lich · Branch: `feat/review-cli-43` → `main` · Reviewed at PR head, up to date with origin/main (no divergence, no conflicts).

## VERDICT: FAIL

### Verification performed

- Full vitest suite on the PR head: 427 passed, 2 failed. Both failures are environment-only (review worktree under `/tmp`; unbuilt `dist/`). Neither touches PR code.
- `tsc --noEmit`: clean.
- Sound and not flagged: `provider_kind_defaults` centralising the per-kind defaults for `env_provider`, `config_template`, and the override path; `config_template` now emitting `base_url`/`api_key_env` for every kind and falling back to `ollama` on an invalid `LICH_PROVIDER_KIND`; `run_chat` carrying `result.messages` as history, continuing on blank lines, and iterating readline asynchronously (piped stdin test passes); `git` and `local` install kinds only print a hint and exit 1, never running `npm install -g`.
- `LICH_BASE_URL` / `LICH_API_KEY_ENV` are consulted only when no config file exists (unchanged from main; docs/user-guide/cli.md:67–68 describe exactly that), so the kind-switch path ignoring them is not a regression.

---

### Findings (most severe first)

#### 1. `src/cli.ts:269` — `--provider-kind` resets `base_url`/`api_key_env` even when the kind did not change

**Why:** `apply_kind_defaults` runs whenever `overrides["provider_kind"]` is present, without comparing against the provider's existing `kind`. A config with `{ kind: "ollama", base_url: "http://gpu-box:11434" }` invoked as `lich --provider-kind ollama …` (no `--base-url`) is silently rewritten to `http://localhost:11434`; an `openai_compat` config pointing at a proxy is rewritten to `https://api.openai.com/v1` and its custom `api_key_env` replaced. Before this PR the flag only patched `kind`. Requests then go to the wrong endpoint with no warning. The new test at test/first_run.test.ts covers only the ollama→anthropic switch.

**Fix hint:** Read `const previous_kind = provider["kind"]` before the override loop and call `apply_kind_defaults` only when `previous_kind !== new_kind`. Add a test: same-kind `--provider-kind` leaves a custom `base_url` and `api_key_env` untouched.

#### 2. `src/cli_update.ts:106` — a project-local install inside a git repository is reported as a git clone

**Why:** When the walk passes a non-global `node_modules` it only sets a flag and keeps climbing, so `repo/node_modules/@moikapy/lich/dist/cli.js` reaches `repo/.git` and returns `"git"`. `lich update` then tells the user to `git pull` in a repository that is not lich. Any project that installed lich as a dependency hits this. The new test "prefers git over a project-local node_modules ancestor" locks the wrong answer in. A genuine clone (`repo/dist/cli.js`) never has a `node_modules` ancestor, so returning `local` immediately loses nothing.

**Fix hint:** Return `"local"` as soon as a non-global `node_modules` directory is seen, and invert that test's expectation.

#### 3. `src/cli_update.ts:81` — Windows npm global layout is no longer recognised

**Why:** npm's global prefix on Windows is `%APPDATA%\npm\node_modules` (no `lib` segment), so `is_npm_global_node_modules` returns false and `lich update` refuses with the local-install hint. Previously any `node_modules` ancestor counted as npm. Low severity if Windows is unsupported; otherwise a regression.

**Fix hint:** Also accept a parent basename of `npm` when `process.platform === "win32"`, or check `env.npm_config_prefix` / `APPDATA`.

#### 4. `src/cli.ts:231` — anthropic→ollama switch deletes `api_key_env` but is untested

**Why:** The `delete provider["api_key_env"]` branch is the only path that removes a key from the user's config, and no test drives it. Given finding 1 it is also the branch most likely to surprise on a same-kind invocation.

**Fix hint:** Add a test for `--provider-kind ollama` on an anthropic config asserting `api_key_env` is absent and `base_url` is the ollama default.

---

### Missing tests

- Same-kind `--provider-kind` no-op (finding 1).
- Project-local install under a git repo → `local` (finding 2, after fixing).
- Windows global layout (finding 3) if supported.
- `run_chat` error path: a throwing `agent.run` should keep the previous history (`return [...history]`) and the loop should continue; current tests cover only the success path and EOF.

---

### Notes (no action required)

- The chat prompt `"> "` is now written manually instead of via `rl.question`; on piped stdin the last prompt has no trailing newline at exit, same as before.
- `KIND_DEFAULTS` in cli_config.ts duplicates the per-provider `DEFAULT_BASE_URL` constants in `src/providers/*.ts`; pre-existing duplication, now in one place on the CLI side.
- CHANGELOG has no entry for the chat memory change or the new `local` install kind.
