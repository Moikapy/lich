import { describe, expect, it } from "vitest";
import { format_chat_status } from "./format_status";
import { INITIAL_UI_STATE, type UiState } from "./types";

function ui(patch: Partial<UiState> = {}): UiState {
  return { ...INITIAL_UI_STATE, ...patch };
}

describe("format_chat_status", () => {
  it("reports connection and session errors before the live session line", () => {
    expect(format_chat_status({ status: "connecting" }, "abcdefghij", undefined, ui())).toBe("connecting");
    expect(format_chat_status({ status: "stopped" }, undefined, "boom", ui())).toBe("stopped");
    expect(format_chat_status({ status: "error" }, "abcdefghij", "sess", ui())).toBe("error: gateway");
    expect(format_chat_status({ status: "error", error: "refused" }, undefined, undefined, ui())).toBe(
      "error: refused",
    );
    expect(format_chat_status({ status: "connected" }, "abcdefghij", "transcript missing", ui({
      phase: "tool",
      turns_used: 4,
      last_error: "hidden",
    }))).toBe("session error: transcript missing");
    expect(format_chat_status({ status: "connected" }, undefined, "", ui())).toBe("session error: ");
    expect(format_chat_status({ status: "connected" }, undefined, undefined, ui())).toBe(
      "connected · creating session…",
    );
  });

  it("shows phase, an 8-char session id, and only positive turns, tokens, and last_error", () => {
    const quiet = format_chat_status({ status: "connected" }, "abcdefghij", undefined, ui());
    expect(quiet).toBe("connected · idle · session abcdefgh");
    const busy = format_chat_status({ status: "connected" }, "abcdefgh", undefined, ui({
      phase: "thinking",
      turns_used: 12,
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 1_234_567 },
      last_error: "denied",
    }));
    expect(busy).toBe("connected · thinking · session abcdefgh · turns 12 · tokens 1,234,567 · err denied");
  });
});
