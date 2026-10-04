/**
 * `lich chat` must keep history across turns, ignore blank lines, and survive
 * piped stdin (readline async iteration) without throwing on close.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../src/providers/types.js";

const chat_state = vi.hoisted(() => ({
  lines: [] as string[],
  runs: [] as Array<{ input: string; history: readonly Message[] }>,
  fail_with: undefined as ((error: Error) => unknown) | undefined,
}));

vi.mock("node:readline", () => ({
  createInterface: () => ({
    async *[Symbol.asyncIterator]() {
      for (const line of chat_state.lines) {
        yield line;
      }
    },
    close: () => undefined,
    on: () => undefined,
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
      const fail_with = chat_state.fail_with;
      if (fail_with !== undefined) {
        chat_state.fail_with = undefined;
        throw fail_with(new Error("provider down"));
      }
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

import { note_partial_messages } from "../src/agent/loop.js";
import { run_chat } from "../src/cli.js";

afterEach(() => {
  chat_state.lines = [];
  chat_state.runs = [];
  chat_state.fail_with = undefined;
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

  it("keeps completed tool turns when a later model call throws", async () => {
    chat_state.fail_with = (error) =>
      note_partial_messages(error, [
        { role: "user", content: "hello" },
        { role: "assistant", content: "", tool_calls: [{ id: "t1", name: "read_file", args: {} }] },
        { role: "tool", tool_call_id: "t1", name: "read_file", content: "file-body" },
      ]);
    chat_state.lines = ["hello", "again", "/exit"];
    const code = await run_chat({ providers: [{ kind: "openai_compat", name: "m", model: "m" }] });
    expect(code).toBe(0);
    expect(chat_state.runs[1]?.history.some((message) => message.role === "tool" && message.content === "file-body")).toBe(
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
