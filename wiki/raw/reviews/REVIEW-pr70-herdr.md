---
source_url: file://lich/REVIEW-pr70-herdr.md (untracked, copied 2026-09-23)
ingested: 2026-09-23
sha256: d061738d349df10440d8833e2884a8d51f6bb429fef191fe36c718ae101db640
---
# Review: PR #70 — fix(gateway): G-4/G-6/G-8/G-9 reconnect backoff and resource bounds

Repo: Moikapy/lich · Branch: `feat/review-gateway-41` → `main` · Reviewed at PR head. main is 3 commits ahead (PR #73 providers work); no gateway files touched there and `git merge-tree` reports no conflicts.

## VERDICT: FAIL

### Verification performed

- Full vitest suite on the PR head: 397 passed, 2 failed. Both failures are environment-only (review worktree under `/tmp`; unbuilt `dist/`). Neither touches PR code.
- `tsc --noEmit`: clean.
- `open_socket` uses the runtime's native `WebSocket`, so `onclose` receives a `CloseEvent` with `.code`; the fatal-close detection in Discord can fire as written.
- Adapter `start` fires the connect loop with `void` and `stop` only flips the flag and closes the socket, so the longer backoff sleep does not block gateway shutdown, but see finding 4 for the timer it leaves behind.
- Sound and not flagged: chain release on settle (`release_chain` compares identity, so a re-queued key is not dropped), `allowed_mentions: { parse: [] }`, `DIRECT_MESSAGES` intent value, heartbeat `d: last_seq`, op 1 immediate heartbeat, `content-length` pre-check with `request.resume()`, Twitch 450-char content cap and inter-chunk gap.

---

### Findings (most severe first)

#### 1. `src/gateway/bus.ts:119` — evicting a history entry also deletes its promise chain, breaking per-conversation serialization

**Why:** `history_for` runs inside `run_once` for some key and evicts the oldest history key when the map is full. The new line also deletes that key's `chains` entry. If the evicted conversation has an in-flight run, the next message for it finds no chain, starts immediately, and runs concurrently with the in-flight one against the same history. The bus's one-run-per-conversation guarantee is what keeps replies ordered and history consistent. Chains are now released on settle by `release_chain`, so this delete is unnecessary.

**Fix (one line, stated, not applied since the branch is not in the working tree):** delete `this.chains.delete(oldest.value);` at bus.ts:119. Add a test: fill `max_conversations`, start a slow run on the oldest key, trigger eviction via a new key, then send a second message to the oldest key and assert it does not start until the first settles.

#### 2. `src/gateway/discord.ts:143` and `src/gateway/twitch.ts:88` — backoff resets on every successful socket open, so clean-close loops never escalate

**Why:** Discord sets `identified = true` on receiving HELLO, which arrives on essentially every successful WebSocket connect, before Discord has accepted the identify. Twitch sets `connected = true` immediately after `open_socket` resolves. Any server that accepts the socket and then closes it (Discord 4000/4008/4010–4013, Twitch `NOTICE * :Login authentication failed` on a bad token) therefore reconnects every 5 s indefinitely. That is the hot loop G-4 (HIGH) was meant to remove; escalation currently only applies when the TCP/WS connect itself fails.

**Fix hint:** Reset backoff on proof of a working session: Discord on `payload.t === "READY"`; Twitch on the `001` welcome or `GLOBALUSERSTATE`. Alternatively reset only when the session lasted longer than the current delay. Also add 4010–4013 to `DISCORD_FATAL_CLOSE` (discord.ts:18): sharding and API-version failures cannot be fixed by reconnecting.

#### 3. `src/gateway/discord.ts:137` region — no heartbeat ACK (op 11) tracking, so a half-open connection is never detected

**Why:** G-9 adds seq and op 1/7/9 handling but never records op 11. Discord's protocol requires closing and reconnecting if an ACK is not received between heartbeats. Without it, a silently dead TCP connection leaves the adapter idle forever with no reconnect, which is the most common production failure for gateway bots.

**Fix hint:** Set `state.ack_pending = true` when sending a heartbeat and clear it on op 11. In the interval, if `ack_pending` is still true, call `socket.close()` so the existing reconnect loop takes over.

#### 4. `src/gateway/discord.ts:95` and `src/gateway/twitch.ts:102` — reconnect sleep is not abortable, holding the process open for up to 30 s after stop

**Why:** `sleep(delay)` is called without a signal. `stop()` flips `running` but cannot interrupt the timer, and the timer is not unref'd, so a SIGINT during the 30 s wait keeps the process alive until it fires. The previous code had the same shape at 5 s; this PR raises the worst case to 30 s.

**Fix hint:** Create an `AbortController` per adapter, pass `controller.signal` to `sleep`, abort it in `stop()`, and catch `sleep_aborted` to exit the loop. The `sleep` util already supports this.

#### 5. `src/gateway/twitch.ts:163` — chunk boundaries can produce a chunk starting with `/` or `.`

**Why:** `sanitize_twitch_outbound` strips leading command markers from the whole reply, but `split_chunks` slices at fixed 450-char offsets, so a later chunk may begin with `/` (a URL split inside `https://`, for example). Twitch treats a leading `/` as a command: unknown commands are rejected and the chunk is silently dropped.

**Fix hint:** Apply the leading-marker strip to each chunk before `socket.send`, or split on whitespace and then sanitize per chunk.

#### 6. `src/gateway/webhook.ts:132` — oversized chunked bodies are fully consumed before the 413 is sent

**Why:** When `size > max_bytes`, `read_body` flags `too_large` but keeps draining the stream until `end`. A client streaming many megabytes without `content-length` ties up the handler for the whole upload. Low severity.

**Fix hint:** On `too_large`, resolve immediately and call `request.destroy()` after responding 413, or `request.pause()` and respond.

---

### Missing tests

- **Reconnect loop** (both adapters): no test covers backoff escalation, reset after a healthy session, or the fatal-close stop. Mock `open_socket` via `vi.mock("../src/gateway/types.js")` with a fake socket whose `onclose` you trigger; assert the sequence of `sleep` delays and that 4004 ends the loop.
- **Discord payload handling:** `handle_discord_payload` is not exported, so op 1 → heartbeat with seq, op 7/9 → close, and seq tracking have no unit coverage. Export it (or a thin wrapper) and test with a fake socket recording `send`.
- **Bus eviction vs in-flight chain:** see finding 1.
- **Webhook oversized body without `content-length`:** the existing 413 test at test/gateway.test.ts:444 sends a string body, for which `fetch` sets `content-length`, so only the header path is exercised. Add a case using a `ReadableStream` body (chunked) to cover `read_body`'s streaming cap.
- **Twitch per-chunk sanitization and gap:** assert that a 900-char reply produces two `PRIVMSG` sends, neither starting with `/` or `.`, separated by the chunk gap (use fake timers).

---

### Notes (no action required)

- Op 7 (reconnect) and op 9 (invalid session) both go through the full backoff delay; Discord suggests immediate reconnect for op 7 and a 1–5 s wait for op 9. Current behavior is acceptable but slower than necessary.
- `irc_session` dropped its unused `keep_running` parameter; fine.
- CHANGELOG has no entry for the new intents, the fatal-close stop, or the 413 limit. Worth a 0.8.0 line.
