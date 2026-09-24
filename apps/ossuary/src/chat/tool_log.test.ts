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
        key: "1:c1:0",
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
    expect(entries[0]?.key).toBe("1:c1:0");
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

  it("keeps parallel empty-id calls as separate rows", () => {
    const empty_shell = { id: "", name: "shell", args: { cmd: "a" } };
    const empty_read = { id: "", name: "read", args: { path: "b" } };
    let entries = apply_tool_log_event([], {
      type: "tool_call_start",
      turn: 1,
      call: empty_shell,
    });
    entries = apply_tool_log_event(entries, {
      type: "tool_call_start",
      turn: 1,
      call: empty_read,
    });
    expect(entries).toHaveLength(2);
    expect(entries.map((item) => item.key)).toEqual(["1::0", "1::1"]);

    entries = apply_tool_log_event(entries, {
      type: "tool_call_end",
      turn: 1,
      call: empty_shell,
      result: { ok: true, output: "ok-shell" },
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]?.status).toBe("ok");
    expect(entries[0]?.name).toBe("shell");
    expect(entries[1]?.status).toBe("running");

    entries = apply_tool_log_event(entries, {
      type: "tool_call_end",
      turn: 1,
      call: empty_read,
      result: { ok: true, output: "ok-read" },
    });
    expect(entries.map((item) => item.status)).toEqual(["ok", "ok"]);
    expect(entries.map((item) => item.key)).toEqual(["1::0", "1::1"]);
  });

  it("pairs same-name empty-id ends with the latest running row", () => {
    const call_a = { id: "", name: "shell", args: { cmd: "a" } };
    const call_b = { id: "", name: "shell", args: { cmd: "b" } };
    let entries = apply_tool_log_event([], {
      type: "tool_call_start",
      turn: 2,
      call: call_a,
    });
    entries = apply_tool_log_event(entries, {
      type: "tool_call_start",
      turn: 2,
      call: call_b,
    });
    entries = apply_tool_log_event(entries, {
      type: "tool_call_end",
      turn: 2,
      call: call_b,
      result: { ok: true, output: "b-done" },
    });
    expect(entries[0]?.status).toBe("running");
    expect(entries[0]?.args).toEqual({ cmd: "a" });
    expect(entries[1]?.status).toBe("ok");
    expect(entries[1]?.output).toBe("b-done");
  });

  it("ignores non-tool events", () => {
    expect(apply_tool_log_event([], { type: "llm_start", turn: 1 })).toEqual([]);
  });
});
