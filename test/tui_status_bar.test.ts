import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "ink";
import { StatusBar } from "../src/tui/status_bar.js";
import { INITIAL_UI_STATE } from "../src/tui/state.js";
import { LICH_THEME } from "../src/util/lore.js";

const strip_ansi = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

describe("StatusBar", () => {
  it("wraps a long status line as one paragraph instead of side-by-side columns", () => {
    const state = {
      ...INITIAL_UI_STATE,
      turns_used: 25,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 789_878 },
      budget_exhausted: true,
      session_path: "/home/u/proj/.lich/sessions/mvfdqfzd-6rj9-858320-1-tui.jsonl",
    };
    const output = strip_ansi(
      renderToString(createElement(StatusBar, { state, model: "glm-5.3:cloud", theme: LICH_THEME }), { columns: 60 }),
    );
    const flat = output.split("\n").map((line) => line.trimEnd()).join(" ");
    expect(flat).toContain("dormant · glm-5.3:cloud · turn 25 · 789,878 tokens");
    expect(flat).toContain("mvfdqfzd-6rj9-858320-1-tui");
    expect(flat).toContain("budget exhausted");
  });
});
