import { describe, expect, it, beforeEach } from "vitest";
import {
  bind_active_session,
  get_active_session,
  reset_active_session,
  subscribe_active_session,
} from "./active_session";
import { resume_banner_block, resume_banner_line } from "./resume_banner";

describe("resume_banner_line", () => {
  it("matches TUI resume banner semantics", () => {
    expect(resume_banner_line("m1abc-1-tui", 4)).toBe("resumed m1abc-1-tui (4 messages)");
    expect(resume_banner_block("latest-id", 0)).toEqual({
      role: "meta",
      lines: ["\u00b7 resumed latest-id (0 messages)"],
    });
  });
});

describe("active_session bridge", () => {
  beforeEach(() => {
    reset_active_session();
  });

  it("publishes bindings with monotonically increasing seq", () => {
    const seen: number[] = [];
    const stop = subscribe_active_session((binding) => seen.push(binding.seq));
    const first = bind_active_session({ session_id: "a", source: "auto_create" });
    const second = bind_active_session({
      session_id: "b",
      source: "resume",
      resume_id: "old",
      message_count: 3,
    });
    stop();
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(get_active_session()?.session_id).toBe("b");
    expect(seen).toEqual([1, 2]);
  });

  it("replays current binding to late subscribers", () => {
    bind_active_session({ session_id: "late", source: "create" });
    let got: string | undefined;
    const stop = subscribe_active_session((binding) => {
      got = binding.session_id;
    });
    stop();
    expect(got).toBe("late");
  });
});
