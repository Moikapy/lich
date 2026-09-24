import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("../session/session_rpc", () => ({
  session_clear: vi.fn(),
  session_create: vi.fn(),
  session_resume: vi.fn(),
}));

import {
  bind_active_session,
  get_active_session,
  reset_active_session,
} from "../session/active_session";
import { session_clear, session_create, session_resume } from "../session/session_rpc";
import {
  clear_active_session,
  resume_listed_session,
  start_fresh_session,
} from "./session_actions";

const clear_rpc = vi.mocked(session_clear);
const create_rpc = vi.mocked(session_create);
const resume_rpc = vi.mocked(session_resume);

describe("session_actions", () => {
  beforeEach(() => {
    reset_active_session();
    clear_rpc.mockReset();
    create_rpc.mockReset();
    resume_rpc.mockReset();
  });

  it("resume binds bag id and transcript label", async () => {
    resume_rpc.mockResolvedValueOnce({ session_id: "bag-1", message_count: 5 });
    await resume_listed_session("alpha-1");
    expect(get_active_session()).toMatchObject({
      session_id: "bag-1",
      source: "resume",
      resume_id: "alpha-1",
      message_count: 5,
    });
  });

  it("start_fresh creates first then clears the previous bag", async () => {
    bind_active_session({ session_id: "old", source: "auto_create" });
    clear_rpc.mockResolvedValueOnce("old");
    create_rpc.mockResolvedValueOnce("fresh-1");
    await start_fresh_session();
    expect(create_rpc).toHaveBeenCalledWith("ossuary", "fresh");
    expect(clear_rpc).toHaveBeenCalledWith("old");
    const create_order = create_rpc.mock.invocationCallOrder[0];
    const clear_order = clear_rpc.mock.invocationCallOrder[0];
    expect(create_order).toBeDefined();
    expect(clear_order).toBeDefined();
    expect(create_order!).toBeLessThan(clear_order!);
    expect(get_active_session()).toMatchObject({
      session_id: "fresh-1",
      source: "create",
    });
  });

  it("start_fresh still binds when create succeeds and previous clear fails", async () => {
    bind_active_session({ session_id: "old", source: "auto_create" });
    create_rpc.mockResolvedValueOnce("fresh-2");
    clear_rpc.mockRejectedValueOnce(new Error("clear failed"));
    await start_fresh_session();
    expect(get_active_session()).toMatchObject({
      session_id: "fresh-2",
      source: "create",
    });
  });

  it("clear_active rebinds the same session id", async () => {
    bind_active_session({ session_id: "s1", source: "create" });
    clear_rpc.mockResolvedValueOnce("s1");
    await clear_active_session();
    expect(get_active_session()).toMatchObject({ session_id: "s1", source: "clear" });
  });
});
