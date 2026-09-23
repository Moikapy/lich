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

  it("start_fresh clears current then creates", async () => {
    bind_active_session({ session_id: "old", source: "auto_create" });
    clear_rpc.mockResolvedValueOnce("old");
    create_rpc.mockResolvedValueOnce("fresh-1");
    await start_fresh_session();
    expect(clear_rpc).toHaveBeenCalledWith("old");
    expect(create_rpc).toHaveBeenCalledWith("ossuary", "fresh");
    expect(get_active_session()).toMatchObject({
      session_id: "fresh-1",
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
