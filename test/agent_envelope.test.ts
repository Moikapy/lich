import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { create_agent } from "../src/agent/agent.js";
import type { AgentEvent } from "../src/agent/events.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const temp_dirs: string[] = [];

afterAll(async () => {
  for (const dir of temp_dirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function make_temp_dir(): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(path.join(TMP_BASE, "agent-envelope-"));
  temp_dirs.push(dir);
  return dir;
}

function completion_body(message: Record<string, unknown>, finish_reason: string) {
  return {
    model: "mock-model",
    choices: [{ message, finish_reason }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  };
}

function scripted_fetch(bodies: unknown[]): typeof fetch {
  let index = 0;
  return async () => {
    const body = bodies[Math.min(index, bodies.length - 1)];
    index += 1;
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

describe("agent event envelope", () => {
  it("emits enveloped run_start/run_end on events and on_event", async () => {
    const work_dir = await make_temp_dir();
    const agent = create_agent({
      providers: [
        {
          kind: "openai_compat",
          name: "mock",
          model: "mock-model",
          base_url: "http://mock.local/v1",
          fetch_fn: scripted_fetch([
            completion_body({ role: "assistant", content: "hi" }, "stop"),
          ]),
        },
      ],
      work_dir,
      session_dir: path.join(work_dir, "sessions"),
      tools_enabled: [],
      log_level: "error",
    });

    const bus: AgentEvent[] = [];
    const per_run: AgentEvent[] = [];
    const stop = agent.events.on((event) => bus.push(event));
    const result = await agent.run({
      input: "ping",
      session_id: "sess-1",
      on_event: (event) => per_run.push(event),
    });
    stop();

    expect(result.outcome.stopped_reason).toBe("final");
    expect(bus.map((event) => event.type).slice(0, 1)).toEqual(["run_start"]);
    expect(bus.at(-1)?.type).toBe("run_end");
    expect(per_run).toEqual(bus);

    for (const [index, event] of bus.entries()) {
      expect(event.run_id).toEqual(bus[0]?.run_id);
      expect(event.session_id).toBe("sess-1");
      expect(event.seq).toBe(index + 1);
      expect(typeof event.ts).toBe("number");
    }

    const end = bus.at(-1);
    expect(end?.type).toBe("run_end");
    if (end?.type === "run_end") {
      expect(end.stopped_reason).toBe("final");
    }
  });
});
