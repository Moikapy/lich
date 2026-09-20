/**
 * A-5 / A-6: per-run usage isolation and memoized MCP attach.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { create_agent } from "../src/agent/agent.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const temp_dirs: string[] = [];

afterAll(async () => {
  for (const dir of temp_dirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function make_temp_dir(): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(path.join(TMP_BASE, "agent-usage-"));
  temp_dirs.push(dir);
  return dir;
}

function completion_body(tokens: number) {
  return {
    model: "mock-model",
    choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: tokens, completion_tokens: 0, total_tokens: tokens },
  };
}

describe("Agent.run concurrent usage (A-5)", () => {
  it("does not mix usage_total across overlapping runs on one Agent", async () => {
    const work_dir = await make_temp_dir();
    let call = 0;
    const fetch_fn: typeof fetch = async () => {
      call += 1;
      const tokens = call === 1 ? 2 : 4;
      // Stagger so both runs overlap on the shared emitter path.
      if (call === 1) {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return new Response(JSON.stringify(completion_body(tokens)), { status: 200 });
    };
    const agent = create_agent({
      providers: [
        {
          kind: "openai_compat",
          name: "mock",
          model: "mock-model",
          base_url: "http://mock.local/v1",
          fetch_fn,
        },
      ],
      work_dir,
      session_dir: path.join(work_dir, "sessions"),
    });
    const [a, b] = await Promise.all([agent.run({ input: "one" }), agent.run({ input: "two" })]);
    const totals = [a.usage_total.total_tokens, b.usage_total.total_tokens].sort((x, y) => x - y);
    expect(totals).toEqual([2, 4]);
  });
});
