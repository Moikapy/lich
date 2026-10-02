/**
 * T-4: gateway conversation-map bounds (max_conversations eviction).
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse_agent_config } from "../src/agent/config.js";
import type { Agent, AgentRunResult } from "../src/agent/agent.js";
import { GatewayBus } from "../src/gateway/bus.js";
import type { Message, Usage } from "../src/providers/types.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const usage_zero: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
const temp_dirs: string[] = [];

afterAll(() => {
  for (const dir of temp_dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function make_temp_dir(): string {
  mkdirSync(TMP_BASE, { recursive: true });
  const dir = mkdtempSync(join(TMP_BASE, "gw-bounds-"));
  temp_dirs.push(dir);
  return dir;
}

interface RunRecord {
  input: string;
  history_len: number;
}

function echo_result(input: string, history: readonly Message[]): AgentRunResult {
  const messages: Message[] = [
    ...history,
    { role: "user", content: input },
    { role: "assistant", content: `echo:${input}` },
  ];
  return {
    outcome: {
      messages,
      final: { role: "assistant", content: `echo:${input}` },
      result: undefined,
      turns_used: 1,
      stopped_reason: "final",
    },
    messages,
    usage_total: usage_zero,
    session_path: undefined,
  };
}

function recording_agent(records: RunRecord[]): Agent {
  return {
    run: async (options: { input: string; history?: readonly Message[] }): Promise<AgentRunResult> => {
      const history = options.history ?? [];
      records.push({ input: options.input, history_len: history.length });
      return echo_result(options.input, history);
    },
  } as unknown as Agent;
}

interface HeldRun {
  input: string;
  history_len: number;
  release: () => void;
}

/** Agent whose run stays open until the test releases it. */
function holding_agent(started: HeldRun[]): Agent {
  return {
    run: async (options: { input: string; history?: readonly Message[] }): Promise<AgentRunResult> => {
      const history = options.history ?? [];
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      started.push({ input: options.input, history_len: history.length, release });
      await gate;
      return echo_result(options.input, history);
    },
  } as unknown as Agent;
}

async function wait_for_start(started: readonly HeldRun[], input: string): Promise<HeldRun> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const found = started.find((run) => run.input === input);
    if (found !== undefined) {
      return found;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`run ${input} did not start`);
}

describe("gateway max_conversations", () => {
  it("evicts the oldest conversation when the map is full", async () => {
    const work_dir = make_temp_dir();
    const records: RunRecord[] = [];
    const bus = new GatewayBus(
      {
        config: parse_agent_config({
          providers: [{ kind: "openai_compat", name: "main", model: "mock-model" }],
          work_dir,
        }),
        agent_factory: () => recording_agent(records),
      },
      { max_conversations: 2, history_cap: 40 },
    );

    expect(await bus.handle("webhook", "a", "u", "a1")).toBe("echo:a1");
    expect(await bus.handle("webhook", "b", "u", "b1")).toBe("echo:b1");
    expect(await bus.handle("webhook", "c", "u", "c1")).toBe("echo:c1");
    // Cap 2: inserting c evicted a. Re-entering a starts empty; map is now [c, a].
    expect(await bus.handle("webhook", "a", "u", "a2")).toBe("echo:a2");
    const a2 = records.find((record) => record.input === "a2");
    expect(a2?.history_len).toBe(0);

    // c still retained history from c1.
    expect(await bus.handle("webhook", "c", "u", "c2")).toBe("echo:c2");
    const c2 = records.find((record) => record.input === "c2");
    expect(c2?.history_len).toBeGreaterThan(0);
  });

  it("keeps an in-flight chain after history eviction so later turns stay serialized", async () => {
    const work_dir = make_temp_dir();
    const started: HeldRun[] = [];
    const bus = new GatewayBus(
      {
        config: parse_agent_config({
          providers: [{ kind: "openai_compat", name: "main", model: "mock-model" }],
          work_dir,
          log_level: "error",
        }),
        agent_factory: () => holding_agent(started),
      },
      { max_conversations: 1, history_cap: 40 },
    );

    const first = bus.handle("webhook", "a", "u", "a1");
    (await wait_for_start(started, "a1")).release();
    expect(await first).toBe("echo:a1");

    const second = bus.handle("webhook", "a", "u", "a2");
    const a2 = await wait_for_start(started, "a2");
    expect(a2.history_len).toBeGreaterThan(0);

    const other = bus.handle("webhook", "b", "u", "b1");
    const b1 = await wait_for_start(started, "b1");
    const chains = (bus as unknown as { chains: Map<string, Promise<void>> }).chains;
    expect(chains.has("webhook:a")).toBe(true);

    const third = bus.handle("webhook", "a", "u", "a3");
    await new Promise((resolve) => setImmediate(resolve));
    expect(started.some((run) => run.input === "a3")).toBe(false);

    a2.release();
    expect(await second).toBe("echo:a2");
    const a3 = await wait_for_start(started, "a3");
    expect(a3.history_len).toBeGreaterThan(0);
    a3.release();
    b1.release();
    expect(await third).toBe("echo:a3");
    expect(await other).toBe("echo:b1");
  });
});
