/**
 * T-4 (A-3 / A-4): Agent.run abort mid-chat and mid-tool via real Agent + mock provider.
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
  const dir = await mkdtemp(path.join(TMP_BASE, "agent-abort-"));
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

describe("Agent.run abort", () => {
  it("returns aborted when chat throws AbortError after the signal fires", async () => {
    const work_dir = await make_temp_dir();
    const controller = new AbortController();
    const fetch_fn: typeof fetch = async () => {
      controller.abort();
      const error = new Error("fetch aborted");
      error.name = "AbortError";
      throw error;
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
      log_level: "error",
    });

    const result = await agent.run({ input: "go", signal: controller.signal });
    expect(result.outcome.stopped_reason).toBe("aborted");
    expect(result.messages.some((message) => message.role === "assistant")).toBe(false);
  });

  it("cancels remaining tool calls when abort fires during the first tool", async () => {
    const work_dir = await make_temp_dir();
    const controller = new AbortController();
    let calls = 0;
    const fetch_fn: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify(
            completion_body(
              {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "t1",
                    type: "function",
                    function: { name: "list_dir", arguments: JSON.stringify({ path: "." }) },
                  },
                  {
                    id: "t2",
                    type: "function",
                    function: { name: "list_dir", arguments: JSON.stringify({ path: "." }) },
                  },
                ],
              },
              "tool_calls",
            ),
          ),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify(completion_body({ role: "assistant", content: "should-not-run" }, "stop")),
        { status: 200 },
      );
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
      tools_enabled: ["list_dir"],
      log_level: "error",
    });

    // Abort as soon as the first tool_call_start fires so the second call is cancelled.
    const stop = agent.events.on((event) => {
      if (event.type === "tool_call_start" && event.call.id === "t1") {
        controller.abort();
      }
    });

    const result = await agent.run({ input: "list twice", signal: controller.signal });
    stop();

    expect(result.outcome.stopped_reason).toBe("aborted");
    const tool_messages = result.messages.filter((message) => message.role === "tool");
    expect(tool_messages).toHaveLength(2);
    const cancelled = tool_messages[1];
    expect(cancelled?.role).toBe("tool");
    if (cancelled?.role === "tool") {
      expect(cancelled.tool_call_id).toBe("t2");
      expect(cancelled.content).toContain("cancelled");
      expect(cancelled.is_error).toBe(true);
    }
  });
});
