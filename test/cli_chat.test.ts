/**
 * `lich chat` must keep history across turns, ignore blank lines, and survive
 * piped stdin (readline async iteration) without throwing on close.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../src/providers/types.js";

const chat_state = vi.hoisted(() => ({
  lines: [] as string[],
  runs: [] as Array<{ input: string; history: readonly Message[] }>,
}));

vi.mock("node:readline", () => ({
  createInterface: () => ({
    async *[Symbol.asyncIterator]() {
      for (const line of chat_state.lines) {
        yield line;
      }
    },
    close: () => undefined,
  }),
}));

vi.mock("../src/agent/agent.js", () => ({
  create_agent_with_plugins: async () => ({
    config: { theme: "lich" },
    events: { on: () => () => undefined },
    close: () => undefined,
    run: async (options: { input: string; history?: readonly Message[] }) => {
      const history = options.history ?? [];
      chat_state.runs.push({ input: options.input, history });
      const messages: Message[] = [
        ...history,
        { role: "user", content: options.input },
        { role: "assistant", content: `echo:${options.input}` },
      ];
      return {
        outcome: { final: messages[messages.length - 1], turns_used: 1, stopped_reason: "final", messages },
        messages,
        usage_total: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    },
  }),
}));

vi.mock("../src/util/theme.js", () => ({
  load_theme: () => ({ glyph: "*", goodbye: "bye", notices: { budget_exhausted: "" } }),
  notice_flavor: () => "",
}));

import { run_chat } from "../src/cli.js";

afterEach(() => {
  chat_state.lines = [];
  chat_state.runs = [];
});

describe("run_chat", () => {
  it("keeps history across turns and skips blank lines", async () => {
    chat_state.lines = ["hello", "  ", "again", "/exit"];
    const code = await run_chat({ providers: [{ kind: "openai_compat", name: "m", model: "m" }] });
    expect(code).toBe(0);
    expect(chat_state.runs.map((run) => run.input)).toEqual(["hello", "again"]);
    expect(chat_state.runs[1]?.history.some((message) => message.role === "user" && message.content === "hello")).toBe(
      true,
    );
  });

  it("processes every piped line without throwing when stdin closes", async () => {
    chat_state.lines = ["a", "b", "c"];
    const code = await run_chat({ providers: [{ kind: "openai_compat", name: "m", model: "m" }] });
    expect(code).toBe(0);
    expect(chat_state.runs.map((run) => run.input)).toEqual(["a", "b", "c"]);
    expect(chat_state.runs[2]?.history.length).toBeGreaterThan(0);
  });
});
