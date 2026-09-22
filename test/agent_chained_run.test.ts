/**
 * T-3 / T-4 (A-1): real chained Agent.run — mocks must not hide history duplication.
 * Mock OpenAI-compat provider only; sessions under test/.tmp.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  const dir = await mkdtemp(path.join(TMP_BASE, "agent-chained-"));
  temp_dirs.push(dir);
  return dir;
}

function completion_body(message: Record<string, unknown>, finish_reason: string) {
  return {
    model: "mock-model",
    choices: [{ message, finish_reason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function tool_call_body(id: string, name: string, args: Record<string, unknown>) {
  return {
    role: "assistant",
    content: "",
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

function scripted_fetch(bodies: unknown[]): typeof fetch {
  let call = 0;
  return () => {
    const body = bodies[call] ?? bodies[bodies.length - 1];
    call += 1;
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  };
}

describe("chained Agent.run (A-1)", () => {
  it("chains three runs with a tool turn without duplicating history", async () => {
    const work_dir = await make_temp_dir();
    await writeFile(path.join(work_dir, "note.txt"), "alpha", "utf8");
    const agent = create_agent({
      providers: [
        {
          kind: "openai_compat",
          name: "mock",
          model: "mock-model",
          base_url: "http://mock.local/v1",
          fetch_fn: scripted_fetch([
            completion_body(tool_call_body("c1", "read_file", { path: "note.txt" }), "tool_calls"),
            completion_body({ role: "assistant", content: "saw alpha" }, "stop"),
            completion_body({ role: "assistant", content: "round two" }, "stop"),
            completion_body({ role: "assistant", content: "round three" }, "stop"),
          ]),
        },
      ],
      work_dir,
      session_dir: path.join(work_dir, "sessions"),
      tools_enabled: ["read_file"],
      system_prompt: "sys",
      log_level: "error",
    });

    const first = await agent.run({ input: "read note" });
    expect(first.outcome.stopped_reason).toBe("final");
    expect(first.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(first.messages.filter((message) => message.role === "system")).toHaveLength(1);

    const second = await agent.run({ input: "again", history: first.messages });
    expect(second.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(second.messages.filter((message) => message.role === "system")).toHaveLength(1);
    expect(second.messages.at(-1)?.content).toBe("round two");

    const third = await agent.run({ input: "third", history: second.messages });
    expect(third.messages.filter((message) => message.role === "system")).toHaveLength(1);
    expect(third.messages.filter((message) => message.role === "user")).toHaveLength(3);
    expect(third.messages.at(-1)?.content).toBe("round three");
    expect(third.messages).toHaveLength(9);
  });
});
