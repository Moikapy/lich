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
  runs: [] as Array<{ input: string; history: readonly Message[] }>,
  finished: 0,
  release: undefined as (() => void) | undefined,
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
    // "slow" waits for the abort, "stuck" also ignores it until released, "midtool" has
    // already replied this turn when the abort lands; anything else replies at once.
    run: async (options: { input: string; history?: readonly Message[]; signal?: AbortSignal }) => {
      const signal = options.signal;
      if (signal === undefined) {
        throw new Error("no signal");
      }
      const history = options.history ?? [];
      sigint_state.signals.push(signal);
      sigint_state.runs.push({ input: options.input, history });
      const messages: Message[] = [...history, { role: "user", content: options.input }];
      const usage_total = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      if (options.input !== "slow" && options.input !== "stuck" && options.input !== "midtool") {
        messages.push({ role: "assistant", content: `echo:${options.input}` });
        const final = messages[messages.length - 1];
        return { outcome: { final, turns_used: 1, stopped_reason: "final", messages }, messages, usage_total };
      }
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      if (options.input === "stuck") {
        await new Promise<void>((resolve) => {
          sigint_state.release = resolve;
        });
      }
      sigint_state.finished += 1;
      if (options.input === "midtool") {
        messages.push({ role: "assistant", content: "partial reply" });
      }
      // Like the loop: on abort `final` is the last assistant so far.
      const final = [...messages].reverse().find((message) => message.role === "assistant");
      return { outcome: { final, turns_used: 0, stopped_reason: "aborted", messages }, messages, usage_total };
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
  sigint_state.release = undefined;
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

  it("one-shot: a second SIGINT while the run is still cancelling exits 130", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const baseline = process.listeners("SIGINT");
    const pending = run_one_shot(CONFIG, "stuck");
    await until(() => sigint_state.signals.length === 1);
    send_sigint(baseline);
    await until(() => sigint_state.release !== undefined);
    expect(exit).not.toHaveBeenCalled();
    send_sigint(baseline);
    expect(exit).toHaveBeenCalledWith(130);
    sigint_state.release?.();
    expect(await pending).toBe(1);
  });

  it("chat: a reply this turn wrote before the cancel is printed and kept", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    const baseline = process.listeners("SIGINT");
    sigint_state.lines = ["midtool", "after"];
    const pending = run_chat(CONFIG);
    await until(() => sigint_state.signals.length === 1);
    sigint_state.rl?.emit("SIGINT");
    await until(() => sigint_state.runs.length === 2);
    expect(stdout).toContain("partial reply\n");
    expect(sigint_state.runs[1]?.history.map((message) => message.content)).toEqual(["midtool", "partial reply"]);
    send_sigint(baseline);
    expect(await pending).toBe(0);
  });

  it("chat: Ctrl+C cancels the running turn, then ends chat at the prompt", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    const baseline = process.listeners("SIGINT");
    sigint_state.lines = ["first", "slow", "after"];
    const pending = run_chat(CONFIG);
    await until(() => sigint_state.signals.length === 2);
    sigint_state.rl?.emit("SIGINT");
    await until(() => sigint_state.runs.length === 3);
    expect(sigint_state.signals[1]?.aborted).toBe(true);
    expect(sigint_state.rl?.closed).toBe(false);
    // The cancelled line is dropped and the previous reply is not printed again.
    expect(sigint_state.runs[2]?.history.map((message) => message.content)).toEqual(["first", "echo:first"]);
    expect(stdout.filter((chunk) => chunk === "echo:first\n")).toHaveLength(1);
    send_sigint(baseline);
    expect(await pending).toBe(0);
    expect(sigint_state.runs.map((run) => run.input)).toEqual(["first", "slow", "after"]);
    expect(process.listeners("SIGINT")).toEqual(baseline);
  });
});
