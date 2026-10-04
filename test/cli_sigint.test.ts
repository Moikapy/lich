/**
 * Ctrl+C in the CLI (#133): one-shot aborts the run; chat cancels the running
 * turn and keeps the session, and at the prompt ends chat.
 */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../src/providers/types.js";

const sigint_state = vi.hoisted(() => ({
  lines: [] as string[],
  rl: undefined as (EventEmitter & { closed: boolean }) | undefined,
  signals: [] as AbortSignal[],
  runs: [] as string[],
  finished: 0,
}));

vi.mock("node:readline", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  return {
    createInterface: () => {
      const rl = Object.assign(new Emitter(), { closed: false });
      sigint_state.rl = rl;
      const closed = new Promise<void>((resolve) => rl.once("close", resolve));
      return Object.assign(rl, {
        async *[Symbol.asyncIterator]() {
          for (const line of sigint_state.lines) {
            yield line;
          }
          await closed;
        },
        close: () => {
          if (rl.closed === false) {
            rl.closed = true;
            rl.emit("close");
          }
        },
      });
    },
  };
});

vi.mock("../src/agent/agent.js", () => ({
  create_agent_with_plugins: async () => ({
    config: { theme: "lich" },
    events: { on: () => () => undefined },
    close: () => undefined,
    run: async (options: { input: string; history?: readonly Message[]; signal?: AbortSignal }) => {
      const signal = options.signal;
      if (signal === undefined) {
        throw new Error("no signal");
      }
      sigint_state.signals.push(signal);
      sigint_state.runs.push(options.input);
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      sigint_state.finished += 1;
      const messages: Message[] = [...(options.history ?? []), { role: "user", content: options.input }];
      return {
        outcome: { final: undefined, turns_used: 1, stopped_reason: "aborted", messages },
        messages,
        usage_total: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    },
  }),
}));

vi.mock("../src/util/theme.js", () => ({
  load_theme: () => ({ glyph: "*", goodbye: "bye", notices: { budget_exhausted: "" } }),
  notice_flavor: () => "",
}));

import { run_chat, run_one_shot } from "../src/cli.js";

const CONFIG = { providers: [{ kind: "openai_compat", name: "m", model: "m" }] };

afterEach(() => {
  vi.restoreAllMocks();
  sigint_state.lines = [];
  sigint_state.rl = undefined;
  sigint_state.signals = [];
  sigint_state.runs = [];
  sigint_state.finished = 0;
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && check() === false; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(check()).toBe(true);
}

/** Call only the SIGINT listeners the code under test added, never the runner's own. */
function send_sigint(baseline: readonly unknown[]): void {
  for (const listener of process.listeners("SIGINT")) {
    if (baseline.includes(listener) === false) {
      listener("SIGINT");
    }
  }
}

describe("CLI Ctrl+C", () => {
  it("one-shot: SIGINT aborts the run, exits 1 and removes its listener", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const baseline = process.listeners("SIGINT");
    const pending = run_one_shot(CONFIG, "slow");
    await until(() => sigint_state.signals.length === 1);
    send_sigint(baseline);
    expect(await pending).toBe(1);
    expect(sigint_state.signals[0]?.aborted).toBe(true);
    expect(process.listeners("SIGINT")).toEqual(baseline);
  });

  it("chat: Ctrl+C cancels the running turn, then ends chat at the prompt", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const baseline = process.listeners("SIGINT");
    sigint_state.lines = ["slow"];
    const pending = run_chat(CONFIG);
    await until(() => sigint_state.signals.length === 1);
    sigint_state.rl?.emit("SIGINT");
    await until(() => sigint_state.finished === 1);
    expect(sigint_state.signals[0]?.aborted).toBe(true);
    expect(sigint_state.rl?.closed).toBe(false);
    send_sigint(baseline);
    expect(await pending).toBe(0);
    expect(sigint_state.runs).toEqual(["slow"]);
    expect(process.listeners("SIGINT")).toEqual(baseline);
  });
});
