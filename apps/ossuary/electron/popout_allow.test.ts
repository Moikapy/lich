import { describe, expect, it } from "vitest";
import { is_allowed_popout_url, POPOUT_PATH } from "./popout_allow.js";

const origin = "http://127.0.0.1:5173";

describe("is_allowed_popout_url", () => {
  it("allows same-origin loopback popout.html", () => {
    expect(is_allowed_popout_url(`${origin}${POPOUT_PATH}`, origin)).toBe(true);
  });

  it("denies other paths on the same origin", () => {
    expect(is_allowed_popout_url(`${origin}/`, origin)).toBe(false);
    expect(is_allowed_popout_url(`${origin}/index.html`, origin)).toBe(false);
  });

  it("denies other hosts, schemes, and garbage", () => {
    expect(is_allowed_popout_url("http://127.0.0.1:9999/popout.html", origin)).toBe(false);
    expect(is_allowed_popout_url("https://127.0.0.1:5173/popout.html", origin)).toBe(false);
    expect(is_allowed_popout_url("file:///tmp/popout.html", origin)).toBe(false);
    expect(is_allowed_popout_url("not a url", origin)).toBe(false);
  });
});
