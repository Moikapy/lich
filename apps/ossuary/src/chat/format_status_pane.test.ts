import { describe, expect, it } from "vitest";
import { format_status_pane_fields, format_token_count } from "./format_status_pane";
import { INITIAL_UI_STATE } from "./types";

describe("format_status_pane_fields", () => {
  it("formats TUI-analogue status fields", () => {
    const fields = format_status_pane_fields(
      { status: "connected" },
      {
        ...INITIAL_UI_STATE,
        phase: "tool",
        turns_used: 3,
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 1234 },
        session_path: "/tmp/s.jsonl",
      },
      "local-model",
    );
    expect(fields).toEqual({
      model: "local-model",
      phase: "tool",
      turns: "3",
      tokens: "1,234",
      session_path: "/tmp/s.jsonl",
      connection: "connected",
    });
  });

  it("uses em dash when session path is missing", () => {
    const fields = format_status_pane_fields({ status: "connecting" }, INITIAL_UI_STATE, "unknown");
    expect(fields.session_path).toBe("—");
    expect(fields.connection).toBe("connecting");
  });
});

describe("format_token_count", () => {
  it("uses US grouping", () => {
    expect(format_token_count(1_000_000)).toBe("1,000,000");
  });
});
