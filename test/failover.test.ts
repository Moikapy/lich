import { describe, expect, it } from "vitest";
import { compute_backoff_ms, classify_error, run_with_retries } from "../src/providers/failover.js";
import { chat_with_failover, ProviderRouter } from "../src/providers/router.js";
import { ProviderError } from "../src/providers/types.js";
import type { ChatResult, ProviderConfig } from "../src/providers/types.js";

const OK_BODY = {
  model: "gpt-test",
  choices: [{ message: { role: "assistant", content: "fine" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

function rate_limit_error(provider_name: string, retry_after_ms?: number): ProviderError {
  return new ProviderError({
    kind: "rate_limit",
    provider_name,
    message: "slow down",
    status: 429,
    ...(retry_after_ms !== undefined ? { retry_after_ms } : {}),
  });
}

function openai_config(name: string, fetch_fn: typeof fetch): ProviderConfig {
  return { kind: "openai_compat", name, model: "gpt-test", api_key: "sk-test", fetch_fn };
}

interface MockReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  text_body?: string;
}

function mock_fetch(responder: () => MockReply): typeof fetch {
  return () => {
    const reply = responder();
    const body_text = reply.text_body ?? JSON.stringify(reply.body ?? {});
    return Promise.resolve(new Response(body_text, { status: reply.status, headers: reply.headers }));
  };
}

describe("classify_error", () => {
  it("passes through ProviderError kinds", () => {
    expect(classify_error(rate_limit_error("p"))).toBe("rate_limit");
    expect(classify_error(new ProviderError({ kind: "auth", provider_name: "p", message: "nope" }))).toBe("auth");
  });

  it("maps TypeError and abort-shaped errors to network", () => {
    expect(classify_error(new TypeError("fetch failed"))).toBe("network");
    const abort_error = new Error("aborted");
    abort_error.name = "AbortError";
    expect(classify_error(abort_error)).toBe("network");
  });

  it("falls back to unknown", () => {
    expect(classify_error(new Error("boom"))).toBe("unknown");
    expect(classify_error("just a string")).toBe("unknown");
  });
});

describe("compute_backoff_ms", () => {
  it("grows exponentially with deterministic jitter", () => {
    expect(compute_backoff_ms(0)).toBe(500);
    expect(compute_backoff_ms(1)).toBe(1250);
    expect(compute_backoff_ms(2)).toBe(2500);
    expect(compute_backoff_ms(3)).toBe(4750);
  });

  it("is deterministic and capped at max_ms", () => {
    expect(compute_backoff_ms(2)).toBe(compute_backoff_ms(2));
    expect(compute_backoff_ms(10)).toBe(8000);
    expect(compute_backoff_ms(10, 100, 400)).toBe(400);
  });
});

describe("run_with_retries", () => {
  it("succeeds after transient network then rate_limit failures", async () => {
    const seen_kinds: string[] = [];
    const seen_attempts: number[] = [];
    const seen_delays: number[] = [];
    const result = await run_with_retries(
      (attempt) => {
        seen_attempts.push(attempt);
        if (attempt === 1) {
          return Promise.reject(new TypeError("fetch failed"));
        }
        if (attempt === 2) {
          return Promise.reject(rate_limit_error("p"));
        }
        return Promise.resolve("done");
      },
      {
        max_attempts: 3,
        on_retry: (kind, attempt, delay_ms) => {
          seen_kinds.push(kind);
          seen_delays.push(delay_ms);
          void attempt;
        },
      },
    );
    expect(result).toBe("done");
    expect(seen_attempts).toEqual([1, 2, 3]);
    expect(seen_kinds).toEqual(["network", "rate_limit"]);
    expect(seen_delays).toEqual([1250, 2500]);
  });

  it("throws non-retryable errors immediately", async () => {
    let calls = 0;
    const failure = await run_with_retries(
      () => {
        calls += 1;
        return Promise.reject(new ProviderError({ kind: "bad_request", provider_name: "p", message: "bad" }));
      },
      { max_attempts: 3 },
    ).catch((error: unknown) => error);
    expect(calls).toBe(1);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).kind).toBe("bad_request");
  });

  it("exhausts retries on rate_limit and throws the last error", async () => {
    let calls = 0;
    const failure = await run_with_retries(
      () => {
        calls += 1;
        return Promise.reject(rate_limit_error("p"));
      },
      { max_attempts: 2 },
    ).catch((error: unknown) => error);
    expect(calls).toBe(2);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).kind).toBe("rate_limit");
  });

  it("rethrows immediately when the caller signal is already aborted", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const failure = await run_with_retries(
      () => {
        calls += 1;
        return Promise.reject(rate_limit_error("p"));
      },
      { max_attempts: 3, signal: controller.signal },
    ).catch((error: unknown) => error);
    expect(calls).toBe(1);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe("AbortError");
  });
});

describe("ProviderRouter", () => {
  it("rejects an empty config list", () => {
    expect(() => new ProviderRouter([])).toThrow("at least one provider is required");
  });

  it("builds providers lazily, caches them, and exposes list and default", () => {
    const router = new ProviderRouter([openai_config("primary", mock_fetch(() => ({ status: 200, body: OK_BODY })))]);
    const first_get = router.get("primary");
    expect(first_get?.name).toBe("primary");
    expect(first_get?.model).toBe("gpt-test");
    expect(router.get("primary")).toBe(first_get);
    expect(router.get("missing")).toBeUndefined();
    expect(router.list().length).toBe(1);
    expect(router.default_provider()).toBe(first_get);
  });

  it("delegates chat_with_failover from the instance method", async () => {
    const router = new ProviderRouter([openai_config("primary", mock_fetch(() => ({ status: 200, body: OK_BODY })))]);
    const result = await router.chat_with_failover([{ role: "user", content: "hi" }], []);
    expect(result.message.content).toBe("fine");
  });
});

describe("chat_with_failover", () => {
  it("falls through to the next provider on auth errors", async () => {
    const router = new ProviderRouter([
      openai_config("locked", mock_fetch(() => ({ status: 401, body: { error: { message: "nope" } } }))),
      openai_config("backup", mock_fetch(() => ({ status: 200, body: OK_BODY }))),
    ]);
    const result = await chat_with_failover(router, [{ role: "user", content: "hi" }], []);
    expect(result.provider_name).toBe("backup");
  });

  it("retries a rate-limited provider before moving on", async () => {
    let calls = 0;
    const router = new ProviderRouter([
      openai_config("throttled", mock_fetch(() => {
        calls += 1;
        if (calls < 2) {
          return { status: 429, body: { error: { message: "slow down" } }, headers: { "retry-after": "0.01" } };
        }
        return { status: 200, body: OK_BODY };
      })),
      openai_config("backup", mock_fetch(() => ({ status: 500, text_body: "should not be called" }))),
    ]);
    const result = await chat_with_failover(router, [{ role: "user", content: "hi" }], []);
    expect(result.provider_name).toBe("throttled");
    expect(calls).toBe(2);
  });

  it("skips overflow errors immediately", async () => {
    const router = new ProviderRouter([
      openai_config("primary", mock_fetch(() => ({ status: 400, text_body: "context length exceeded" }))),
      openai_config("backup", mock_fetch(() => ({ status: 200, body: OK_BODY }))),
    ]);
    const result = await chat_with_failover(router, [{ role: "user", content: "hi" }], []);
    expect(result.provider_name).toBe("backup");
  });

  it("throws the first hard error when every provider fails", async () => {
    const router = new ProviderRouter([
      openai_config("one", mock_fetch(() => ({ status: 400, text_body: "invalid request payload" }))),
      openai_config("two", mock_fetch(() => ({ status: 503, text_body: "upstream down" }))),
    ]);
    const failure = await chat_with_failover(router, [{ role: "user", content: "hi" }], []).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProviderError);
    const provider_error = failure as ProviderError;
    expect(provider_error.kind).toBe("bad_request");
    expect(provider_error.provider_name).toBe("one");
    expect(provider_error.message).toContain("invalid request payload");
  });

  it("fails over immediately when Retry-After exceeds the cap", async () => {
    let primary_calls = 0;
    const router = new ProviderRouter([
      openai_config("throttled", mock_fetch(() => {
        primary_calls += 1;
        return {
          status: 429,
          body: { error: { message: "slow down" } },
          headers: { "retry-after": "600" },
        };
      })),
      openai_config("backup", mock_fetch(() => ({ status: 200, body: OK_BODY }))),
    ]);
    const result = await chat_with_failover(router, [{ role: "user", content: "hi" }], []);
    expect(result.provider_name).toBe("backup");
    expect(primary_calls).toBe(1);
  });

  it("returns the first provider's success untouched", async () => {
    const router = new ProviderRouter([
      openai_config("primary", mock_fetch(() => ({ status: 200, body: OK_BODY }))),
      openai_config("backup", mock_fetch(() => ({ status: 500, text_body: "never" }))),
    ]);
    const result: ChatResult = await chat_with_failover(router, [{ role: "user", content: "hi" }], []);
    expect(result.provider_name).toBe("primary");
    expect(result.finish_reason).toBe("stop");
  });

  it("rethrows caller aborts without failing over to the next provider", async () => {
    const controller = new AbortController();
    let backup_calls = 0;
    const router = new ProviderRouter([
      openai_config("primary", () => {
        controller.abort();
        const error = new Error("aborted");
        error.name = "AbortError";
        return Promise.reject(error);
      }),
      openai_config("backup", () => {
        backup_calls += 1;
        return Promise.resolve(new Response(JSON.stringify(OK_BODY), { status: 200 }));
      }),
    ]);
    const failure = await chat_with_failover(router, [{ role: "user", content: "hi" }], [], {
      signal: controller.signal,
    }).catch((error: unknown) => error);
    expect(backup_calls).toBe(0);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe("AbortError");
  });
});