---
source_url: https://github.com/ollama/ollama/tree/42e911bc
ingested: 2026-10-03
sha256: 601fcbfed0f92c39031d989f26ac3b3e73c99ee600ca5c7fc098b7d50035ab6d
---
# Ollama System One and Cloudflare Clef: primary-source check (2026-10-03)

Research by a Claude Code subagent from a shallow clone of `ollama/ollama` at
`42e911bc` (2026-10-02), GitHub release/issue pages, and web-search summaries.
ollama.com and blog.cloudflare.com were blocked by the egress proxy.

## Verified (primary source)

1. Decision models listed: Nimble, Tev1, Clef, Clef Flash
   (`docs/capabilities/decision.mdx:16-22`). Clef and Clef Flash need v0.35.1+
   and also accept images. `/v1/systemone` first shipped in v0.35.0
   (`ollama pull nimble`). Release notes v0.35.1
   (github.com/ollama/ollama/releases/tag/v0.35.1) add Clef support and make
   decision models report only the `decision` capability.
2. Local only: "Currently available locally" (`decision.mdx:6-8`). The server
   rejects cloud model refs with "System One requires a local decision model"
   and accepts only GGUF models (`server/routes.go:874-891`).
3. API: route at `server/routes.go:2076`.
   - Request: `{model, state (string or JSON), images?: [base64 PNG/JPEG/WebP],
     questions: {name: {type, instructions, criteria}}}`.
   - Response: `{model, answers: {name: {type, choice, probabilities,
     confidence} | {type: "noul", noul}}, usage}` (`decision.mdx:28-113`).
   - Types: `choice` (2-26 options), `noul` (`false`/`true` descriptions,
     returns P(true)), `score` (2-26 ordered levels, probability-weighted).
   - Limits: 1-64 questions (`decision/systemone.go:41`), 2-26 criteria
     (`:198`); body 64 KiB without images, 32 MiB with
     (`server/routes.go:846-864`).
   - `confidence` = 1 - normalised entropy (`systemone.go:247`); not a
     calibration guarantee (`decision.mdx:129`).
   - Decision models hide other capabilities in show/list
     (`server/images.go:162-167`).
4. ollama.com auth: `https://ollama.com/api` and `/v1` with
   `Authorization: Bearer $OLLAMA_API_KEY`
   (`docs/api/authentication.mdx:11-22`). Not applicable to System One.
5. Open bug github.com/ollama/ollama/issues/18769: on v0.35.1 `clef-flash`
   fails on `/v1/systemone` ("non-finite logit" on CUDA, "cannot open model"
   on CPU); it works on `/v1/chat/completions`; `clef:27b` works.

## Search summaries only (unverified)

- Ollama on X announced `ollama pull clef` / `ollama pull clef-flash`.
- `clef` / `clef:27b` Q4_K_M ~18 GB; `clef:27b-q8_0` ~30 GB; `clef-flash:9b`
  Q8_0, 9.1B params, ~9.5-11 GB (ollama.com library tags, modelfit.io).
- Clef fine-tuned from Qwen3.8-27B, Clef Flash from Qwen3.5-9B.
- MLX System One support (PR #18701) reportedly merged 2026-10-03.
- No new latency benchmarks found.

## Against the 2026-10-02 notes

- Confirmed: v0.35 `/v1/systemone`; `nimble` and `tev1` exist; noul/choice/score;
  ollama.com Bearer auth.
- Contradicted: "Clef is not in the Ollama library" (added in v0.35.1);
  "Ollama (local or ollama.com)" for decision models (local only);
  "up to 255 options" (Ollama caps criteria at 26).
- Still unverified: `nimble`/`tev1` sizes, the ~91 ms latency figure, exact
  Jev wire compatibility, Ollaya.
