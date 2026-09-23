import { describe, expect, it } from "vitest";
import { apply_tool_log_event } from "./tool_log";

const call = { id: "c1", name: "shell", args: { cmd: "ls" } };

describe("apply_tool_log_event", () => {
  it("appends running on tool_call_start and updates on end", () => {
    let entries = apply_tool_log_event([], {
      type: "tool_call_start",
      turn: 1,
      call,
    });
    expect(entries).toEqual([
      {
        id: "c1",
        turn: 1,
        name: "shell",
        args: { cmd: "ls" },
        status: "running",
      },
    ]);

    entries = apply_tool_log_event(entries, {
      type: "tool_call_end",
      turn: 1,
      call,
      result: { ok: true, output: "a\nb" },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe("ok");
    expect(entries[0]?.output).toBe("a\nb");
  });

  it("marks failed and cancelled ends", () => {
    const failed = apply_tool_log_event([], {
      type: "tool_call_end",
      turn: 2,
      call: { id: "c2", name: "read", args: {} },
      result: { ok: false, output: "", error: "missing" },
    });
    expect(failed[0]?.status).toBe("error");
    expect(failed[0]?.error).toBe("missing");

    const cancelled = apply_tool_log_event([], {
      type: "tool_call_end",
      turn: 3,
      call: { id: "c3", name: "shell", args: {} },
      result: { ok: false, output: "" },
      cancelled: true,
    });
    expect(cancelled[0]?.status).toBe("cancelled");
  });

  it("ignores non-tool events", () => {
    expect(apply_tool_log_event([], { type: "llm_start", turn: 1 })).toEqual([]);
  });
});
