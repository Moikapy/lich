---
source_url: file://lich/REVIEW-pr73-herdr.md (untracked, copied 2026-09-23)
ingested: 2026-09-23
sha256: 90124ae4c4eb18b76af3375f12ba80a59d2681f7f4505ba41a7740de8ced6d12
---
# Herdr → Claude review: PR #73 (providers P-2 through P-8)

**Source:** Herdr Claude agent pane `w6590b22082fb22:p2`  
**Date:** 2026-09-22  
**PR:** https://github.com/Moikapy/lich/pull/73

## VERDICT: FAIL

Verified on the PR head (up to date with origin/main): the suite passes except the two
environment-only failures seen on earlier reviews, and tsc --noEmit is clean. Failover
first-hard-error, the Retry-After cap, Ollama num_ctx, the dropped-tool-call handling on
truncation, and the thinking round-trip are sound, and the new provider config keys survive
parsing because the provider schema uses passthrough. One confirmed regression and one
incomplete fix block a pass.

## Findings (most severe first)

### 1. `src/providers/anthropic.ts:21` — tightened overflow regex misses real Anthropic messages (must-fix)

The new pattern was checked against the two texts the API actually sends:
`"prompt is too long: N tokens > M maximum"` and
`"input length and max_tokens exceed context limit: ..."`. Both fail, while the old pattern
matched both. The `prompt.?(too long|too large)` branch allows only one character between
`"prompt"` and `"too"`, so the real `"prompt is too long"` never matches, and `"context
limit"` appears in no alternative. The test at `test/providers.test.ts:244` uses the invented
fixture `"prompt too long: context length exceeded"`, which is why it passed. Raising the
default max_tokens to 16384 in the same PR makes the second message more likely.

**Fix hint:** replace the prompt branch with `prompt is too (long|large)` and add
`exceed.{0,30}context limit`. Change the fixture to the real message text so the test guards
this.

### 2. `src/providers/openai.ts:242` — reasoning models still receive temperature (must-fix)

P-6 switches o-series and gpt-5 to `max_completion_tokens`, but a configured temperature is
still sent, and those models return 400 for any non-default value. The agent forwards
`config.temperature` whenever it is set, so a user with `temperature: 0.2` and model `gpt-5`
still cannot chat.

**Fix:** skip the temperature assignment when `is_reasoning_model(model)` is true, and extend
the `max_completion_tokens` test to assert temperature is absent.

### 3. `src/providers/anthropic.ts:394` — replayed text blocks may be empty or whitespace-only

`provider_content` copies every text block verbatim, and `assistant_to_blocks` returns it
untouched, bypassing the existing placeholder that the reconstructed path applies at
`anthropic.ts:241`. The API rejects input text blocks that contain no non-whitespace text, so
a response with a thinking block plus an empty or newline-only text block fails on the next
turn. Plausible rather than reproduced.

**Fix:** skip text blocks whose trimmed text is empty when building `provider_content`.

### 4. `src/providers/anthropic.ts:27` — 16384 default breaks older Claude models (low)

Models with an 8192 or 4096 output cap return 400 on that value where 4096 previously worked.
Those models are mostly retired, so this is low priority, but the CHANGELOG should call out
the new default and the `max_tokens` override.

### 5. `docs/architecture/providers.md:225` and `CHANGELOG.md` — new keys undocumented

`send_temperature` and `num_ctx` are absent from the provider field table that already
documents `think` and `keep_alive`, and the PR adds no CHANGELOG entry for the temperature
opt-in, the Retry-After cap, the 413 mapping, or the truncation note.

### 6. Missing tests

No test covers the thinking round-trip when `stop_reason` is `max_tokens`, which is the only
path that filters `tool_use` out of `provider_content` while keeping the thinking block. No
test covers a reasoning model with temperature set. The Anthropic overflow test should use the
real message texts named above.
