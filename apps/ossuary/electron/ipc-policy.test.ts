import { describe, expect, it } from "vitest";
import {
  assert_gateway_method,
  GATEWAY_METHOD_ALLOWLIST,
  is_allowed_sender_url,
} from "./ipc-policy.js";

describe("ipc-policy", () => {
  it("allows health, prompt.*, and session.* methods used by the renderer", () => {
    for (const method of GATEWAY_METHOD_ALLOWLIST) {
      expect(() => assert_gateway_method(method)).not.toThrow();
    }
    expect(() => assert_gateway_method("prompt.submit")).not.toThrow();
    expect(() => assert_gateway_method("session.list")).not.toThrow();
  });

  it("rejects unknown methods (deny by default)", () => {
    expect(() => assert_gateway_method("filesystem.read")).toThrow(
      "method not allowed: filesystem.read",
    );
    expect(() => assert_gateway_method("admin.shutdown")).toThrow(
      "method not allowed: admin.shutdown",
    );
  });

  it("rejects missing or disallowed sender URLs", () => {
    const allow = (url: string): boolean => url === "http://127.0.0.1:5173/";
    expect(is_allowed_sender_url(undefined, allow)).toBe(false);
    expect(is_allowed_sender_url("", allow)).toBe(false);
    expect(is_allowed_sender_url("https://evil.example/", allow)).toBe(false);
    expect(is_allowed_sender_url("http://127.0.0.1:5173/", allow)).toBe(true);
  });
});
