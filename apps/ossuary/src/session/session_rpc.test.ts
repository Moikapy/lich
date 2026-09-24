import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../gateway-client", () => ({
  request_gateway: vi.fn(),
}));

import { request_gateway } from "../gateway-client";
import {
  session_clear,
  session_create,
  session_list,
  session_resume,
} from "./session_rpc";

const request = vi.mocked(request_gateway);

describe("session_rpc", () => {
  beforeEach(() => {
    request.mockReset();
  });

  it("parses session.list entries", async () => {
    request.mockResolvedValueOnce({
      sessions: [
        { id: "a-1", mtime_ms: 10 },
        { id: "b-2", mtime_ms: 20 },
      ],
    });
    await expect(session_list()).resolves.toEqual([
      { id: "a-1", mtime_ms: 10 },
      { id: "b-2", mtime_ms: 20 },
    ]);
    expect(request).toHaveBeenCalledWith("session.list", {});
  });

  it("parses session.resume result", async () => {
    request.mockResolvedValueOnce({ session_id: "bag-9", message_count: 4 });
    await expect(session_resume("alpha-1")).resolves.toEqual({
      session_id: "bag-9",
      message_count: 4,
    });
    expect(request).toHaveBeenCalledWith("session.resume", { id: "alpha-1" });
  });

  it("parses session.create and session.clear", async () => {
    request.mockResolvedValueOnce({ session_id: "new-1" });
    await expect(session_create("ossuary", "fresh")).resolves.toBe("new-1");
    expect(request).toHaveBeenCalledWith("session.create", {
      source: "ossuary",
      label: "fresh",
    });

    request.mockResolvedValueOnce({ session_id: "new-1" });
    await expect(session_clear("new-1")).resolves.toBe("new-1");
    expect(request).toHaveBeenCalledWith("session.clear", { session_id: "new-1" });
  });

  it("rejects malformed list payloads", async () => {
    request.mockResolvedValueOnce({ sessions: [{ id: "x" }] });
    await expect(session_list()).rejects.toThrow(/unexpected session.list entry/);
  });
});
