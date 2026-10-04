---
source_url: file://lich/REVIEW-overnight-herdr.md (untracked, copied 2026-09-23)
ingested: 2026-09-23
sha256: fa4947dc24e2250e2a4c2c6cc55f7f8076528f0611588d3cff2d2608b3f97859
---
# Overnight must-fix review (Herdr → Claude)

**Date:** 2026-09-20  
**Target:** `origin/main` @ `90efdec` (PRs #48–#53, #55–#57; tip also has #58)  
**Agent:** Claude via Herdr pane `w6590b22082fb22:p2` (name `claude`; prompt by pane ID)  
**Hermes:** not prompted (docs-only; not used for this review)

## Prompt status

- `HERDR_ENV=1` export was enough for Herdr CLI control from this Cursor shell.
- `herdr agent list` showed idle agents `hermes` and `claude`.
- `herdr agent prompt claude …` failed with `agent_not_found`; pane ID worked.
- First `--wait --timeout 300000` timed out while Claude was still working; later `herdr agent wait` reached `done` and scrollback captured the full review.

---

## Claude review (captured)

### 1. VERDICT: FAIL

There are four must-change items, all reproduced by running the merged code; nothing in the repo was modified. Two are functional regressions introduced by #51 and #52. The other two are gaps where the #50 and #52 security claims don't hold.

On `origin/main` @ `90efdec`, tsc is clean and CI is green on Node 20 and 22. In an isolated export of main, the vitest suite passes 359/360. The one failure comes from the copy living under `/tmp`, not from the code.

### 2. MUST-CHANGE

**M1.** `fetch_url` and `http_request` fail on HTTPS under Node for hosts that resolve to IPv4 (regression from #52, S-2). `src/tools/url_guard.ts:147-153`

- `pin_url` rewrites the URL host to the vetted IP, so the TLS certificate is checked against the IP and the request fails.
- Repro on Node: `safe_fetch("https://api.github.com/zen")` fails with `ERR_TLS_CERT_ALTNAME_INVALID`. The same call works under Bun.
- For IPv6 results, the `pinned.hostname = ip` assignment is silently ignored because the address has no brackets. Those hosts work only because they are not pinned, so the DNS-rebinding protection #52 claims is absent there.
- The tests mock both `dns.lookup` and `fetch`, so TLS is never exercised.
- **Fix:** keep the hostname in the URL and pin at connect time, for example an `undici Agent({ connect: { lookup } })` that returns the vetted address. Add a test asserting that the URL handed to fetch keeps its hostname for `https:`.

**M2.** Under Bun, a one-shot run with a stdio MCP server enabled exits 0 with no answer (regression from #51, M-1). `src/mcp/mcp_stdio_bun.ts:38`

- `child.unref()` lets the event loop drain while `tools/list` is still pending.
- Repro: `bun src/cli.ts "hi"` prints only the plugin log line and exits 0. With the unref removed in a scratch copy, it prints the answer and exits cleanly with no orphan child.
- The Node build (`node dist/cli.js`) is genuinely fixed and exits cleanly.
- **Fix:** drop the Bun unref and rely on `agent.close()`. Add a spawn-level test that runs one-shot on both runtimes and asserts the reply is present and the process exits.

**M3.** `grep_files` bypasses the S-1 symlink guard and the S-3 config deny. `src/tools/builtin/grep_files.ts:110-113` and `:201`

- The directory walk treats a symlink to a file as a regular file and reads through it. A `w/link.txt` pointing at `../out/secret.txt` returned the outside file's content.
- `grep_files {path: ".lich/config.json"}` and `{path: ".lich"}` both returned a literal `api_key`, because `assert_file_tool_access` is never called.
- `grep_files` is in the default gateway toolset.
- **Fix:** skip entries where `entry.isSymbolicLink()` is true, or re-check each file with `resolve_safe_path`. Call `assert_file_tool_access(..., "read")` on the root and on every hit. Add tests for both cases.

**M4.** The Twitch allowlist can be spoofed, which defeats G-2 on that platform. `src/gateway/twitch.ts:158`

- The PRIVMSG regex is not anchored, and the user is taken from the last `!` before the match. The adapter requests `twitch.tv/commands`, so USERNOTICE and WHISPER lines are delivered.
- Repro: `...USERNOTICE #chan :hi x!owner@o PRIVMSG #chan :<payload>` parses as `user=owner` and passes `is_gateway_sender_allowed`. The WHISPER form works the same way.
- **Fix:** anchor it as `^:(\w+)!\S+ PRIVMSG #(\w+) :(.*)$` after stripping tags, and add spoof tests.

### 3. SHOULD-CHANGE

- Terminal env scrub is easy to bypass (`src/tools/builtin/terminal.ts:58`): `/proc/$PPID/environ`, profile re-source via `bash -lc`, configured `api_key_env` / custom token env names not dropped; pattern also drops `SSH_AUTH_SOCK` / `XAUTHORITY`; `run_tests` shares scrub.
- Webhook accepts browser cross-site POSTs when no token is set (`src/gateway/webhook.ts:62-70,83`): no Content-Type/Origin check; default toolset can exfiltrate via `read_file` + `fetch_url`. Require `application/json`, reject Origin, or always require token; cap body size (G-6).
- Redirects forward caller headers cross-origin (`src/tools/url_guard.ts:190`); strip on host change. `LICH_ALLOW_PRIVATE_URLS` undocumented.
- `.lich/plugins/` writable by file tools (`src/tools/guard.ts:77-91`); case-sensitive `.lich/config.json` deny fails on macOS for `.LICH/Config.json`.
- Whitespace-only Anthropic text blocks still pass (`src/providers/anthropic.ts:235,253`); use `trim()`.
- Gateway tool default can widen operator list (`src/gateway/runner.ts:18`); `git_commit` still registered after filter (M-10).
- Claimed fixes with no/weak tests: G-3 reply-send failure; U-1/U-2 TUI; M-1 process exit; abort via `ToolContext.signal`.
- Suite depends on gitignored `test/.tmp`; clean export can fail until `mkdir -p` (CI green; order-dependent). Suggest vitest `globalSetup`.

### 4. NOTES

**Verified fixed:**

- A-1: history returned once; test chains two real runs.
- A-2: compression cut never starts on a tool message.
- A-3 / A-4: abort mid-LLM returns `aborted`; router rethrows; remaining tools get cancelled.
- A-5 / A-6: usage per run; MCP attach memoized.
- G-1: loopback default; non-loopback without token refused.
- G-5 / G-7: webhook platform pinned; history cap drops leading non-user.
- C-1, S-5, S-10.
- `read_file` / `write_file` / `edit_file` reject symlinks, dangling links, `.env*` writes.
- SSRF block list holds for `[::1]`, IPv4-mapped IPv6, decimal IPs, `localhost.`, nip.io.
- U-1 / U-2 look correct in diff; U-1 also ignores slash commands while busy.

**Process notes:**

- #57 merged with red CI (run 35493353878); #58 repaired it.
- `REVIEW.md` checkboxes still unticked; this file and `REVIEW.md` left untracked.
- Same class as `.env` deny, still open: file tools can write `bunfig.toml` with a preload entry.
- Minor: `..hidden.txt` still rejected by `startsWith("..")` (S-11, out of scope).
- Repros ran against a git archive export of `origin/main`; no worktree/commits/writes in the repo; Hermes not touched.

---

## Handoff brief (what was sent)

Council-style review of overnight lich must-fix work on main. Repo: `/home/moika/code/lich`. Use gh/git if available. Do not implement, merge, or commit. Do not disturb Hermes.

Must-fixes #21–#36 via PRs #48–#53; partial should-fix #55–#57; tip also #58. Ask: verify claims vs diffs; VERDICT PASS|FAIL; MUST-CHANGE / SHOULD-CHANGE / NOTES; security + correctness; no merge.
