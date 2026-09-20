/**
 * A-1: Agent.run must return outcome.messages as-is (history already seeded).
 * Mock provider only. Sessions stay under test/.tmp.
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
  const dir = await mkdtemp(path.join(TMP_BASE, "agent-history-"));
  temp_dirs.push(dir);
  return dir;
}

function completion_body(content: string) {
  return {
    model: "mock-model",
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function scripted_fetch(replies: unknown[]): typeof fetch {
  let call = 0;
  return () => {
    const body = replies[call] ?? replies[replies.length - 1];
    call += 1;
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  };
}

describe("Agent.run history contract", () => {
  it("chains two real runs without duplicating prior history", async () => {
    const work_dir = await make_temp_dir();
    const agent = create_agent({
      providers: [
        {
          kind: "openai_compat",
          name: "mock",
          model: "mock-model",
          base_url: "http://mock.local/v1",
          fetch_fn: scripted_fetch([completion_body("first"), completion_body("second")]),
        },
      ],
      work_dir,
      session_dir: path.join(work_dir, "sessions"),
      system_prompt: "sys",
      log_level: "error",
    });

    const first = await agent.run({ input: "hello" });
    expect(first.outcome.stopped_reason).toBe("final");
    expect(first.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
    expect(first.messages.at(-1)?.content).toBe("first");

    const second = await agent.run({ input: "again", history: first.messages });
    expect(second.outcome.stopped_reason).toBe("final");
    expect(second.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(second.messages.filter((message) => message.role === "system")).toHaveLength(1);
    expect(second.messages.at(-1)?.content).toBe("second");
    expect(second.messages).toHaveLength(5);
  });
});
