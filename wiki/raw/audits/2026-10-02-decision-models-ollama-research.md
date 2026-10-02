---
source_url: session:2026-10-02 web research for #148 (search summaries; primary pages blocked)
ingested: 2026-10-02
sha256: f056c4df5b70f80bcff7aa6ad239502bc0b53d71d9b94549ce28378d78e1be78
---
# Decision models and Ollama models: research notes (2026-10-02)

Session research for #148. The primary pages (blog.cloudflare.com, ollama.com,
marktechpost.com) were blocked by the session's network proxy, so these notes
come from web-search result summaries. Treat sizes, latencies and reliability
percentages as approximate and re-check them against the primary sources.

## Decision models ("System One" models)

- TypeSafe AI released Jev on 2026-09-15. It takes program state plus typed
  questions and returns typed answers with calibrated probabilities in one
  parallel pass. API: `POST /v1/systemone`.
- Question types: `noul` (yes/no probability), `choice` (one of up to 255
  labelled options, per-option probabilities plus a confidence value), `score`
  (position on an ordered rubric plus the distribution). Up to 64 named
  questions per request.
- Cloudflare released Clef (27B) and Clef-flash (9B) on Workers AI on
  2026-10-01, Jev-API compatible, weights Apache 2.0 on Hugging Face.
  Clef-flash is built on Qwen3.5-9B with a "joint schema head" that scores
  every option of every question in one forward pass.
- Reported median decision latency: Clef 209.3 ms, Clef-flash 38.8 ms,
  Jev 524.1 ms. Clef leads the Jev Decision Index (132,422 requests across
  37 benchmarks, 30+ open-weight models).
- Cloudflare also launched an RL fine-tuning platform for decision models.
- Known limits: weak on large context, compound questions and vague criteria;
  prompt injection shifts probabilities and can move the answer. Typed output
  alone is not injection resistance; guards built on these models belong
  alongside deterministic checks, not instead of them.
- Typical agent uses: tool or skill routing, safety gates, triage, ranking,
  with "fall back to the LLM when confidence is low".

## Ollama

- Ollama 0.35 (late September 2026) added a local Jev-compatible
  `/v1/systemone` endpoint. Launch models: Bespoke Labs `nimble` (9B,
  fine-tuned from Qwen3.5-9B, ~9.5 GB Q8_0, ~91 ms per decision on an M5 Max)
  and Together AI `tev1` (4B ~4.5 GB, 0.8B ~812 MB, experimental). TypeSafe's
  Python SDK works unchanged against `http://localhost:11434`.
- Clef is not in the Ollama library; Ollaya (ollaya.dev) runs open decision
  models locally behind a TypeSafe-compatible API.
- Ollama cloud: create an API key at ollama.com, call `https://ollama.com` with
  `Authorization: Bearer <key>`. About 94 library models carry the tools tag;
  about 14 of them are cloud-only.
- Tool-calling picks reported for local agents: `qwen3:8b` (~5 GB at Q4_K_M,
  ~85% tool-call reliability), `gemma4` (~90%), `llama3.1:8b` (~80%, fastest
  first token), `qwen3:30b-a3b` for 16-24 GB machines, and
  `llama3-groq-tool-use:8b` (top small fine-tune on BFCL).

## Sources

- https://blog.cloudflare.com/clef-decision-models/
- https://developers.cloudflare.com/changelog/post/2026-10-01-clef-workers-ai/
- https://developers.cloudflare.com/workers-ai/models/clef-flash/
- https://flaviocopes.com/clef/
- https://openrouter.ai/blog/insights/what-is-jev/
- https://jevtypesafeai.com/docs
- https://dev.to/aitejiu/benchmarking-jev-what-a-decision-model-can-and-cant-do-in-an-agent-harness-20po
- https://arxiv.org/html/2609.28613v1
- https://github.com/ollama/ollama/releases/tag/v0.35.0
- https://ollama.com/library/nimble
- https://modelsystem.one/news/ollama-systemone-decision-models/
- https://modelfit.io/blog/ollama-decision-models-nimble-tev1-mac/
- https://github.com/ollaya-dev/ollaya
- https://docs.ollama.com/api/introduction
- https://localaimaster.com/blog/best-ollama-models-tool-calling
- https://localaimaster.com/blog/best-ollama-models-for-agents
