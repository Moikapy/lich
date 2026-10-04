import { describe, expect, it } from "vitest";
import { to_agent_error_payload } from "../src/agent/events.js";
import { ProviderError } from "../src/providers/types.js";

describe("to_agent_error_payload", () => {
  it("keeps ProviderError.kind and drops status, cause, and stack", () => {
    const cause: { self?: unknown } = {};
    cause.self = cause;
    const error = new ProviderError({
      kind: "rate_limit",
      provider_name: "anthropic",
      message: "slow down",
      status: 429,
      retry_after_ms: 1_000,
      cause,
    });

    const payload = to_agent_error_payload(error);

    expect(payload).toEqual({ kind: "rate_limit", message: "slow down" });
    expect(JSON.stringify(payload)).toBe('{"kind":"rate_limit","message":"slow down"}');
  });

  it("uses Error.name and falls back when the name is empty", () => {
    expect(to_agent_error_payload(new TypeError("bad"))).toEqual({
      kind: "TypeError",
      message: "bad",
    });
    const blank = new Error("blank");
    blank.name = "";
    expect(to_agent_error_payload(blank)).toEqual({ kind: "Error", message: "blank" });
  });

  it("stringifies non-Error throwables", () => {
    expect(to_agent_error_payload("nope")).toEqual({ kind: "Error", message: "nope" });
    expect(to_agent_error_payload(undefined)).toEqual({ kind: "Error", message: "undefined" });
  });
});
