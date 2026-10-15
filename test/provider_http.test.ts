/**
 * Shared provider HTTP helpers (src/providers/http.ts). Status mapping,
 * abort combining, and blank-key fallback apply to every chat client.
 */
import { describe, expect, it } from "vitest";
import {
  build_abort_signal,
  build_bearer_headers,
  do_fetch,
  first_non_empty,
  read_success_json,
  to_http_error,
} from "../src/providers/http.js";
import { OpenAICompatProvider } from "../src/providers/openai.js";
import { ProviderError } from "../src/providers/types.js";

const ENV_KEY = "LICH_TEST_OPENAI_KEY";

function named_error(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function http_response(status: number, body: string, headers?: Record<string, string>): Response {
  return new Response(body, { status, headers });
}

describe("provider http helpers", () => {
  it("skips blank values and omits a bearer header when no key is present", () => {
    expect(first_non_empty([undefined, "", "sk-env"])).toBe("sk-env");
    expect(first_non_empty(["", undefined])).toBeUndefined();
    expect(build_bearer_headers(undefined)).toEqual({ "content-type": "application/json" });
    expect(build_bearer_headers("sk")).toEqual({
      "content-type": "application/json",
      authorization: "Bearer sk",
    });
  });

  it("aborts the combined signal when the caller cancels and a timeout is also set", () => {
    const caller = new AbortController();
    const combined = build_abort_signal({ signal: caller.signal }, 60_000);
    expect(combined).toBeInstanceOf(AbortSignal);
    expect(combined).not.toBe(caller.signal);
    expect(combined?.aborted).toBe(false);
    caller.abort();
    expect(combined?.aborted).toBe(true);

    const already = new AbortController();
    already.abort();
    expect(build_abort_signal({ signal: already.signal }, 60_000)?.aborted).toBe(true);
  });

  it("passes a lone caller signal through and ignores a non-positive timeout", () => {
    const caller = new AbortController();
    expect(build_abort_signal({ signal: caller.signal }, undefined)).toBe(caller.signal);
    expect(build_abort_signal({ signal: caller.signal }, 0)).toBe(caller.signal);
    expect(build_abort_signal(undefined, undefined)?.aborted).toBe(false);
  });

  it("classifies abort-shaped fetch failures separately from other network errors", async () => {
    const abort_error = named_error("AbortError", "The operation was aborted");
    const aborted = await do_fetch(
      () => Promise.reject(abort_error),
      "https://api.example/v1",
      { method: "POST" },
      "openai",
    ).catch((error: unknown) => error);
    expect(aborted).toBeInstanceOf(ProviderError);
    expect(aborted).toMatchObject({
      kind: "network",
      provider_name: "openai",
      message: "request aborted or timed out: The operation was aborted",
      cause: abort_error,
    });

    const timeout_error = named_error("TimeoutError", "The operation timed out");
    const timed_out = await do_fetch(
      () => Promise.reject(timeout_error),
      "https://api.example/v1",
      { method: "POST" },
      "openai",
    ).catch((error: unknown) => error);
    expect(timed_out).toMatchObject({
      kind: "network",
      message: "request aborted or timed out: The operation timed out",
    });

    const reset = new TypeError("ECONNRESET");
    const failed = await do_fetch(
      () => Promise.reject(reset),
      "https://api.example/v1",
      { method: "POST" },
      "ollama",
    ).catch((error: unknown) => error);
    expect(failed).toMatchObject({
      kind: "network",
      provider_name: "ollama",
      message: "fetch failed: ECONNRESET",
      cause: reset,
    });

    const bare = await do_fetch(
      () => Promise.reject("socket hang up"),
      "https://api.example/v1",
      { method: "POST" },
      "anthropic",
    ).catch((error: unknown) => error);
    expect(bare).toMatchObject({ kind: "network", message: "fetch failed: socket hang up" });
  });

  it("maps 403 to auth, 529 to rate_limit, and ignores unusable Retry-After values", async () => {
    const forbidden = await to_http_error(http_response(403, "forbidden"), "anthropic");
    expect(forbidden).toMatchObject({ kind: "auth", status: 403, provider_name: "anthropic" });

    const overloaded = await to_http_error(http_response(529, "overloaded"), "anthropic");
    expect(overloaded).toMatchObject({ kind: "rate_limit", status: 529 });
    expect(overloaded.retry_after_ms).toBeUndefined();

    const negative = await to_http_error(http_response(429, "slow", { "retry-after": "-1" }), "openai");
    expect(negative.kind).toBe("rate_limit");
    expect(negative.retry_after_ms).toBeUndefined();

    const dated = await to_http_error(
      http_response(429, "slow", { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" }),
      "openai",
    );
    expect(dated.retry_after_ms).toBeUndefined();

    const fractional = await to_http_error(http_response(429, "slow", { "retry-after": "1.6" }), "openai");
    expect(fractional.retry_after_ms).toBe(1600);
  });

  it("uses the caller overflow pattern and truncates long error bodies", async () => {
    const body = "response too long for this model";
    const shared = await to_http_error(http_response(400, body), "ollama");
    expect(shared.kind).toBe("bad_request");
    const wider = await to_http_error(http_response(400, body), "ollama", /too long/i);
    expect(wider.kind).toBe("overflow");

    const huge = "x".repeat(800);
    const truncated = await to_http_error(http_response(400, huge), "openai");
    expect(truncated.message).toContain("openai http 400:");
    expect(truncated.message).toContain("[... truncated, 300 chars omitted ...]");
  });

  it("turns an unreadable or unparseable success body into a provider error", async () => {
    const parsed = await read_success_json<{ ok: boolean }>(http_response(200, '{"ok":true}'), "openai");
    expect(parsed).toEqual({ ok: true });

    const unparseable = await read_success_json(http_response(200, "not-json"), "openai").catch(
      (error: unknown) => error,
    );
    expect(unparseable).toMatchObject({
      kind: "bad_request",
      message: "unparseable success response: not-json",
    });

    const broken = {
      text: () => Promise.reject(new Error("stream closed")),
    } as unknown as Response;
    const unread = await read_success_json(broken, "anthropic").catch((error: unknown) => error);
    expect(unread).toMatchObject({
      kind: "network",
      provider_name: "anthropic",
      message: "failed to read response body: stream closed",
    });
  });
});

describe("openai key resolution", () => {
  it("treats a blank api_key as missing and uses api_key_env", async () => {
    const previous = process.env[ENV_KEY];
    process.env[ENV_KEY] = "from-env";
    let authorization: string | undefined;
    const fetch_fn: typeof fetch = (_input, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      authorization = headers?.["authorization"];
      const body = JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    };
    try {
      const provider = new OpenAICompatProvider({
        kind: "openai_compat",
        name: "openai-main",
        model: "gpt-test",
        api_key: "",
        api_key_env: ENV_KEY,
        fetch_fn,
      });
      await provider.chat([{ role: "user", content: "hi" }], []);
      expect(authorization).toBe("Bearer from-env");
    } finally {
      if (previous === undefined) {
        delete process.env[ENV_KEY];
      } else {
        process.env[ENV_KEY] = previous;
      }
    }
  });
});
