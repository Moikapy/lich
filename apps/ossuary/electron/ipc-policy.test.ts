import { describe, expect, it } from "vitest";
import { assert_gateway_method, is_allowed_sender_url } from "./ipc-policy.js";

describe("ipc-policy", () => {
  it("allows health and rejects other methods", () => {
    expect(() => assert_gateway_method("health")).not.toThrow();
    expect(() => assert_gateway_method("prompt.submit")).toThrow("method not allowed: prompt.submit");
  });

  it("rejects missing or disallowed sender URLs", () => {
    const allow = (url: string): boolean => url === "http://127.0.0.1:5173/";
    expect(is_allowed_sender_url(undefined, allow)).toBe(false);
    expect(is_allowed_sender_url("", allow)).toBe(false);
    expect(is_allowed_sender_url("https://evil.example/", allow)).toBe(false);
    expect(is_allowed_sender_url("http://127.0.0.1:5173/", allow)).toBe(true);
  });
});
