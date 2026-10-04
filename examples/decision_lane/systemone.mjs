/**
 * Minimal client for Ollama's System One decision endpoint (`POST /v1/systemone`).
 * Wire format and limits follow the Ollama docs (docs/capabilities/decision.mdx,
 * decision/systemone.go at ollama/ollama@42e911bc). Requests are checked before
 * they are sent, so an oversized payload never leaves the machine.
 */

export const SYSTEMONE_LIMITS = Object.freeze({
  max_questions: 64,
  min_criteria: 2,
  max_criteria: 26,
  max_body_bytes: 64 * 1024,
});

const DEFAULT_TIMEOUT_MS = 2000;

/** A failed decision with a short machine-readable `reason` for the decision log. */
export class DecisionError extends Error {
  constructor(reason, message) {
    super(message ?? reason);
    this.name = "DecisionError";
    this.reason = reason;
  }
}

/**
 * Ask typed questions about `state`. Returns `{ answers, latency_ms }`.
 * Throws DecisionError on invalid input, timeout, HTTP error, or a bad response.
 */
export async function systemone({
  base_url,
  model,
  state,
  questions,
  timeout_ms = DEFAULT_TIMEOUT_MS,
  api_key,
  fetch_fn = fetch,
  signal,
}) {
  check_questions(questions);
  const body = JSON.stringify({ model, state, questions });
  if (Buffer.byteLength(body, "utf8") > SYSTEMONE_LIMITS.max_body_bytes) {
    throw new DecisionError("body_too_large");
  }
  const headers = { "Content-Type": "application/json" };
  if (typeof api_key === "string" && api_key.length > 0) {
    headers.Authorization = `Bearer ${api_key}`;
  }
  const timeout = AbortSignal.timeout(timeout_ms);
  const started = performance.now();
  let response;
  try {
    response = await fetch_fn(`${base_url.replace(/\/+$/, "")}/v1/systemone`, {
      method: "POST",
      headers,
      body,
      signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
    });
  } catch (error) {
    if (timeout.aborted === true) {
      throw new DecisionError("timeout");
    }
    if (signal?.aborted === true) {
      throw new DecisionError("aborted");
    }
    throw new DecisionError("network", error instanceof Error ? error.message : String(error));
  }
  if (response.ok === false) {
    throw new DecisionError(`http_${response.status}`);
  }
  let parsed;
  try {
    parsed = await response.json();
  } catch {
    throw new DecisionError("bad_response");
  }
  const answers = parsed?.answers;
  if (typeof answers !== "object" || answers === null) {
    throw new DecisionError("bad_response");
  }
  return { answers, latency_ms: Math.round(performance.now() - started) };
}

function check_questions(questions) {
  const entries = Object.entries(questions ?? {});
  if (entries.length === 0 || entries.length > SYSTEMONE_LIMITS.max_questions) {
    throw new DecisionError("question_count");
  }
  for (const [, question] of entries) {
    if (question.type === "noul") {
      continue;
    }
    const criteria = question.criteria;
    const count = Array.isArray(criteria) ? criteria.length : Object.keys(criteria ?? {}).length;
    if (count < SYSTEMONE_LIMITS.min_criteria || count > SYSTEMONE_LIMITS.max_criteria) {
      throw new DecisionError("criteria_count");
    }
  }
}
