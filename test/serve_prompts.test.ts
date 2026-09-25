/**
 * Serve prompt.submit / abort: events, final reply, abort, one SessionHandle transcript.
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { AgentConfig } from "../src/agent/config.js";
import { create_agent } from "../src/agent/agent.js";
import type { AgentEvent } from "../src/agent/events.js";
import { handle_serve_rpc_message, type ServeRpcContext } from "../src/serve/rpc.js";
import { create_serve_prompt_service } from "../src/serve/prompts.js";
import { create_serve_server, run_serve, type ServeServer } from "../src/serve/server.js";
import { create_serve_session_store } from "../src/serve/sessions.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const servers: ServeServer[] = [];
const created: string[] = [];

async function make_temp_dir(prefix: string): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(path.join(TMP_BASE, `${prefix}-`));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await server?.stop();
  }
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

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

function mock_agent(work_dir: string, fetch_fn: typeof fetch) {
  return create_agent({
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
}

async function rpc(
  context: ServeRpcContext,
  method: string,
  params?: unknown,
  id: number = 1,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { jsonrpc: "2.0", id, method };
  if (params !== undefined) {
    body.params = params;
  }
  const raw = await handle_serve_rpc_message(JSON.stringify(body), context);
  return JSON.parse(raw ?? "") as Record<string, unknown>;
}

describe("serve prompt rpc", () => {
  it("streams events and returns final reply with usage", async () => {
    const work_dir = await make_temp_dir("serve-prompt-ok");
    const session_dir = path.join(work_dir, "sessions");
    const agent = mock_agent(
      work_dir,
      scripted_fetch([completion_body({ role: "assistant", content: "pong" }, "stop")]),
    );
    const sessions = create_serve_session_store(session_dir);
    const prompts = create_serve_prompt_service(agent, sessions);
    const events: AgentEvent[] = [];
    const context: ServeRpcContext = {
      version: "9.9.9",
      sessions,
      prompts,
      notify: (notification) => {
        events.push(notification.params.event);
      },
    };

    const created = (await rpc(context, "session.create", { source: "test" }, 1)).result as {
      session_id: string;
    };
    const response = await rpc(
      context,
      "prompt.submit",
      { session_id: created.session_id, text: "ping" },
      2,
    );
    const result = response.result as {
      reply: string;
      usage: { total_tokens: number };
      session_path: string;
      stopped_reason: string;
      turns_used: number;
    };
    expect(result.reply).toBe("pong");
    expect(result.stopped_reason).toBe("final");
    expect(result.turns_used).toBeGreaterThanOrEqual(1);
    expect(result.usage.total_tokens).toBe(5);
    expect(result.session_path).toContain(created.session_id);
    expect(events.some((event) => event.type === "final")).toBe(true);
    expect(events.some((event) => event.type === "turn_start")).toBe(true);
    expect(events.some((event) => event.type === "run_start")).toBe(true);
    expect(events.some((event) => event.type === "run_end")).toBe(true);
    const start = events.find((event) => event.type === "run_start");
    expect(start?.run_id).toEqual(expect.any(String));
    expect(start?.session_id).toBe(created.session_id);
    expect(start?.seq).toBe(1);
    expect(typeof start?.ts).toBe("number");
  });

  it("aborts an in-flight run via prompt.abort", async () => {
    const work_dir = await make_temp_dir("serve-prompt-abort");
    const session_dir = path.join(work_dir, "sessions");
    let fetch_started!: () => void;
    const started = new Promise<void>((resolve) => {
      fetch_started = resolve;
    });
    const fetch_fn: typeof fetch = async (_url, init) => {
      fetch_started();
      const signal = init?.signal;
      await new Promise<void>((_resolve, reject) => {
        const fail = (): void => {
          const error = new Error("fetch aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (signal?.aborted === true) {
          fail();
          return;
        }
        signal?.addEventListener("abort", fail, { once: true });
      });
      throw new Error("unreachable");
    };
    const agent = mock_agent(work_dir, fetch_fn);
    const sessions = create_serve_session_store(session_dir);
    const prompts = create_serve_prompt_service(agent, sessions);
    const context: ServeRpcContext = { version: "9.9.9", sessions, prompts };

    const created = (await rpc(context, "session.create", { source: "test" }, 1)).result as {
      session_id: string;
    };
    const submit_promise = rpc(
      context,
      "prompt.submit",
      { session_id: created.session_id, text: "hang" },
      2,
    );
    await started;
    const abort_response = await rpc(context, "prompt.abort", { session_id: created.session_id }, 3);
    expect(abort_response.result).toEqual({ session_id: created.session_id, aborted: true });
    const submit = await submit_promise;
    const result = submit.result as { stopped_reason: string };
    expect(result.stopped_reason).toBe("aborted");
  });

  it("returns an aborted result for a prompt aborted while queued", async () => {
    const work_dir = await make_temp_dir("serve-prompt-queued-abort");
    const session_dir = path.join(work_dir, "sessions");
    let fetch_started!: () => void;
    const started = new Promise<void>((resolve) => {
      fetch_started = resolve;
    });
    let fetch_calls = 0;
    const fetch_fn: typeof fetch = async (_url, init) => {
      fetch_calls += 1;
      if (fetch_calls === 1) {
        fetch_started();
        // The running run must observe the abort even while a queued submit
        // exists, so hang on the abort signal like a real provider call.
        const signal = init?.signal;
        await new Promise<void>((_resolve, reject) => {
          const fail = (): void => {
            const error = new Error("fetch aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (signal?.aborted === true) {
            fail();
            return;
          }
          signal?.addEventListener("abort", fail, { once: true });
        });
        throw new Error("unreachable");
      }
      return new Response(
        JSON.stringify(completion_body({ role: "assistant", content: "done" }, "stop")),
        { status: 200 },
      );
    };
    const agent = mock_agent(work_dir, fetch_fn);
    const sessions = create_serve_session_store(session_dir);
    const prompts = create_serve_prompt_service(agent, sessions);
    const context: ServeRpcContext = { version: "9.9.9", sessions, prompts };

    const created = (await rpc(context, "session.create", { source: "test" }, 1)).result as {
      session_id: string;
    };
    const first_promise = rpc(
      context,
      "prompt.submit",
      { session_id: created.session_id, text: "first" },
      2,
    );
    await started;
    // Second submit queues behind the first; its controller must be registered
    // before the queue wait so prompt.abort can cancel it.
    const second_promise = rpc(
      context,
      "prompt.submit",
      { session_id: created.session_id, text: "second" },
      3,
    );
    const abort_response = await rpc(
      context,
      "prompt.abort",
      { session_id: created.session_id },
      4,
    );
    expect(abort_response.result).toEqual({ session_id: created.session_id, aborted: true });

    // Both controllers are aborted: the running run's fetch rejects and the
    // queued submit settles with the zero-usage result.
    const first = (await first_promise).result as { stopped_reason: string; reply: string };
    expect(first.stopped_reason).toBe("aborted");
    const second = (await second_promise).result as {
      stopped_reason: string;
      turns_used: number;
      reply: string | undefined;
      usage: { total_tokens: number };
    };
    expect(second.stopped_reason).toBe("aborted");
    expect(second.turns_used).toBe(0);
    expect(second.usage.total_tokens).toBe(0);
    expect(second.reply).toBeUndefined();
    expect(fetch_calls).toBe(1);
  });

  it("abort cancels the running run even when another submit is queued", async () => {
    const work_dir = await make_temp_dir("serve-prompt-queued-cancel");
    const session_dir = path.join(work_dir, "sessions");
    let fetch_started!: () => void;
    const started = new Promise<void>((resolve) => {
      fetch_started = resolve;
    });
    let fetch_calls = 0;
    const fetch_fn: typeof fetch = async (_url, init) => {
      fetch_calls += 1;
      if (fetch_calls === 1) {
        fetch_started();
        const signal = init?.signal;
        await new Promise<void>((_resolve, reject) => {
          const fail = (): void => {
            const error = new Error("fetch aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (signal?.aborted === true) {
            fail();
            return;
          }
          signal?.addEventListener("abort", fail, { once: true });
        });
        throw new Error("unreachable");
      }
      return new Response(
        JSON.stringify(completion_body({ role: "assistant", content: "done" }, "stop")),
        { status: 200 },
      );
    };
    const agent = mock_agent(work_dir, fetch_fn);
    const sessions = create_serve_session_store(session_dir);
    const prompts = create_serve_prompt_service(agent, sessions);
    const context: ServeRpcContext = { version: "9.9.9", sessions, prompts };

    const created = (await rpc(context, "session.create", { source: "test" }, 1)).result as {
      session_id: string;
    };
    const first_promise = rpc(
      context,
      "prompt.submit",
      { session_id: created.session_id, text: "first" },
      2,
    );
    await started;
    const second_promise = rpc(
      context,
      "prompt.submit",
      { session_id: created.session_id, text: "second" },
      3,
    );
    const abort_response = await rpc(
      context,
      "prompt.abort",
      { session_id: created.session_id },
      4,
    );
    expect(abort_response.result).toEqual({ session_id: created.session_id, aborted: true });

    // The running run must be cancelled too, not just the queued one.
    const first = (await first_promise).result as { stopped_reason: string };
    expect(first.stopped_reason).toBe("aborted");
    const second = (await second_promise).result as {
      stopped_reason: string;
      turns_used: number;
      usage: { total_tokens: number };
    };
    expect(second.stopped_reason).toBe("aborted");
    expect(second.turns_used).toBe(0);
    expect(second.usage.total_tokens).toBe(0);
    // The queued submit never started its model call.
    expect(fetch_calls).toBe(1);
  });

  it("stop() aborts a running and a queued submit instead of draining the model call", async () => {
    const work_dir = await make_temp_dir("serve-stop-queued-abort");
    const session_dir = path.join(work_dir, "sessions");
    let fetch_started!: () => void;
    const started = new Promise<void>((resolve) => {
      fetch_started = resolve;
    });
    let fetch_calls = 0;
    const fetch_fn: typeof fetch = async (_url, init) => {
      fetch_calls += 1;
      if (fetch_calls === 1) {
        fetch_started();
        const signal = init?.signal;
        await new Promise<void>((_resolve, reject) => {
          const fail = (): void => {
            const error = new Error("fetch aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (signal?.aborted === true) {
            fail();
            return;
          }
          signal?.addEventListener("abort", fail, { once: true });
        });
        throw new Error("unreachable");
      }
      return new Response(
        JSON.stringify(completion_body({ role: "assistant", content: "done" }, "stop")),
        { status: 200 },
      );
    };
    const agent = mock_agent(work_dir, fetch_fn);
    const server = create_serve_server({
      port: 0,
      boot_stdout: null,
      session_dir,
      agent,
      version: "9.9.9",
    });
    servers.push(server);
    await server.start();
    const prompts = server.prompts;
    if (prompts === undefined) {
      throw new Error("prompts service missing");
    }
    const created = (await server.sessions.create({ source: "test" })).session_id;

    const first_promise = prompts.submit(
      { session_id: created, text: "first" },
      () => undefined,
    );
    await started;
    const second_promise = prompts.submit(
      { session_id: created, text: "second" },
      () => undefined,
    );
    const t0 = Date.now();
    await server.stop();
    // Without abort_all() the drain would wait out the hanging fetch.
    expect(Date.now() - t0).toBeLessThan(5000);
    const first = await first_promise;
    expect(first.stopped_reason).toBe("aborted");
    const second = await second_promise;
    expect(second.stopped_reason).toBe("aborted");
    expect(second.turns_used).toBe(0);
    expect(second.usage.total_tokens).toBe(0);
    expect(fetch_calls).toBe(1);
  });

  it("does not resurrect stale history after session.clear mid-run", async () => {
    const work_dir = await make_temp_dir("serve-prompt-clear-race");
    const session_dir = path.join(work_dir, "sessions");
    let fetch_started!: () => void;
    const started = new Promise<void>((resolve) => {
      fetch_started = resolve;
    });
    let release_first!: () => void;
    const first_gate = new Promise<void>((resolve) => {
      release_first = resolve;
    });
    const request_bodies: string[] = [];
    const replies = ["stale-reply", "after-clear"];
    let fetch_calls = 0;
    const fetch_fn: typeof fetch = async (_url, init) => {
      fetch_calls += 1;
      request_bodies.push(String(init?.body ?? ""));
      if (fetch_calls === 1) {
        fetch_started();
        await first_gate;
      }
      return new Response(
        JSON.stringify(
          completion_body({ role: "assistant", content: replies[Math.min(fetch_calls, 2) - 1] }, "stop"),
        ),
        { status: 200 },
      );
    };
    const agent = mock_agent(work_dir, fetch_fn);
    const sessions = create_serve_session_store(session_dir);
    const prompts = create_serve_prompt_service(agent, sessions);
    const context: ServeRpcContext = { version: "9.9.9", sessions, prompts };

    const created = (await rpc(context, "session.create", { source: "test" }, 1)).result as {
      session_id: string;
    };
    const submit_promise = rpc(
      context,
      "prompt.submit",
      { session_id: created.session_id, text: "clear-me" },
      2,
    );
    await started;
    const cleared = await rpc(context, "session.clear", { session_id: created.session_id }, 3);
    expect(cleared.result).toEqual({ session_id: created.session_id });

    release_first();
    const submit = (await submit_promise).result as { stopped_reason: string; reply: string };
    expect(submit.stopped_reason).toBe("final");
    // The finished run must not write its messages back into the cleared bag.
    expect(sessions.get(created.session_id)?.history).toEqual([]);

    // A subsequent submit works and starts from the cleared (empty) history.
    const second = (await rpc(
      context,
      "prompt.submit",
      { session_id: created.session_id, text: "after-clear" },
      4,
    )).result as { reply: string };
    expect(second.reply).toBe("after-clear");
    expect(request_bodies).toHaveLength(2);
    expect(request_bodies[1]).toContain("after-clear");
    expect(request_bodies[1]).not.toContain("stale-reply");
    expect(request_bodies[1]).not.toContain("clear-me");
    const history_after = sessions.get(created.session_id)?.history ?? [];
    expect(JSON.stringify(history_after)).not.toContain("stale-reply");
    expect(JSON.stringify(history_after)).not.toContain("clear-me");
  });

  it("reuses one SessionHandle transcript across multi-turn submits", async () => {
    const work_dir = await make_temp_dir("serve-prompt-multi");
    const session_dir = path.join(work_dir, "sessions");
    const agent = mock_agent(
      work_dir,
      scripted_fetch([
        completion_body({ role: "assistant", content: "one" }, "stop"),
        completion_body({ role: "assistant", content: "two" }, "stop"),
      ]),
    );
    const sessions = create_serve_session_store(session_dir);
    const prompts = create_serve_prompt_service(agent, sessions);
    const context: ServeRpcContext = { version: "9.9.9", sessions, prompts };

    const created = (await rpc(context, "session.create", { source: "ossuary", label: "chat" }, 1))
      .result as { session_id: string };
    const first = (await rpc(
      context,
      "prompt.submit",
      { session_id: created.session_id, text: "a" },
      2,
    )).result as { session_path: string; reply: string };
    const second = (await rpc(
      context,
      "prompt.submit",
      { session_id: created.session_id, text: "b" },
      3,
    )).result as { session_path: string; reply: string };

    expect(first.reply).toBe("one");
    expect(second.reply).toBe("two");
    expect(second.session_path).toBe(first.session_path);
    expect(sessions.get(created.session_id)?.handle.path).toBe(first.session_path);

    const raw = await readFile(first.session_path, "utf8");
    expect(raw).toContain('"content":"a"');
    expect(raw).toContain('"content":"one"');
    expect(raw).toContain('"content":"b"');
    expect(raw).toContain('"content":"two"');
  });

  it("returns aborted:false when nothing is in flight", async () => {
    const work_dir = await make_temp_dir("serve-prompt-idle");
    const sessions = create_serve_session_store(path.join(work_dir, "sessions"));
    const prompts = create_serve_prompt_service(
      mock_agent(work_dir, scripted_fetch([completion_body({ role: "assistant", content: "x" }, "stop")])),
      sessions,
    );
    const context: ServeRpcContext = { version: "9.9.9", sessions, prompts };
    const created = (await rpc(context, "session.create", { source: "test" }, 1)).result as {
      session_id: string;
    };
    const response = await rpc(context, "prompt.abort", { session_id: created.session_id }, 2);
    expect(response.result).toEqual({ session_id: created.session_id, aborted: false });
  });

  it("notifies JSON-safe error payloads instead of empty Error objects", async () => {
    const work_dir = await make_temp_dir("serve-prompt-error-wire");
    const session_dir = path.join(work_dir, "sessions");
    const agent = mock_agent(work_dir, async () => {
      throw new Error("provider down");
    });
    const sessions = create_serve_session_store(session_dir);
    const prompts = create_serve_prompt_service(agent, sessions);
    const events: AgentEvent[] = [];
    const context: ServeRpcContext = {
      version: "9.9.9",
      sessions,
      prompts,
      notify: (notification) => {
        events.push(JSON.parse(JSON.stringify(notification.params.event)) as AgentEvent);
      },
    };

    const created = (await rpc(context, "session.create", { source: "test" }, 1)).result as {
      session_id: string;
    };
    const response = await rpc(
      context,
      "prompt.submit",
      { session_id: created.session_id, text: "ping" },
      2,
    );
    expect(response.error).toBeDefined();

    const error_event = events.find((event) => event.type === "error");
    expect(error_event?.type).toBe("error");
    if (error_event?.type !== "error") {
      return;
    }
    const payload = error_event.error;
    expect(typeof payload.kind).toBe("string");
    expect(typeof payload.message).toBe("string");
    expect(payload.message.length).toBeGreaterThan(0);
    expect(Object.keys(payload).sort()).toEqual(["kind", "message"]);
  });

  it("isolates concurrent sessions: events stay tagged and runs overlap", async () => {
    const work_dir = await make_temp_dir("serve-prompt-concurrent");
    const session_dir = path.join(work_dir, "sessions");
    const started: string[] = [];
    const release_gates = new Map<string, () => void>();
    const agent = mock_agent(work_dir, async (_input, init) => {
      const signal = init?.signal;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 80);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            const error = new Error("fetch aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
      return new Response(
        JSON.stringify(completion_body({ role: "assistant", content: "ok" }, "stop")),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    // Patch run to record session start ordering via on_event session_id.
    const original_run = agent.run.bind(agent);
    agent.run = async (options) => {
      started.push(options.session_id ?? "");
      const release = release_gates.get(options.session_id ?? "");
      if (release !== undefined) {
        release();
      }
      return original_run(options);
    };
    const sessions = create_serve_session_store(session_dir);
    const prompts = create_serve_prompt_service(agent, sessions);
    const events: AgentEvent[] = [];
    const context: ServeRpcContext = {
      version: "9.9.9",
      sessions,
      prompts,
      notify: (notification) => {
        events.push(notification.params.event);
      },
    };

    const a = (await rpc(context, "session.create", { source: "test" }, 1)).result as {
      session_id: string;
    };
    const b = (await rpc(context, "session.create", { source: "test" }, 2)).result as {
      session_id: string;
    };

    const both_started = Promise.all([
      new Promise<void>((resolve) => {
        release_gates.set(a.session_id, resolve);
      }),
      new Promise<void>((resolve) => {
        release_gates.set(b.session_id, resolve);
      }),
    ]);

    const submit_a = rpc(
      context,
      "prompt.submit",
      { session_id: a.session_id, text: "a" },
      3,
    );
    const submit_b = rpc(
      context,
      "prompt.submit",
      { session_id: b.session_id, text: "b" },
      4,
    );

    await both_started;
    expect(new Set(started)).toEqual(new Set([a.session_id, b.session_id]));

    const [result_a, result_b] = await Promise.all([submit_a, submit_b]);
    expect((result_a.result as { stopped_reason: string }).stopped_reason).toBe("final");
    expect((result_b.result as { stopped_reason: string }).stopped_reason).toBe("final");

    for (const event of events) {
      expect(event.session_id === a.session_id || event.session_id === b.session_id).toBe(true);
      expect(typeof event.run_id).toBe("string");
      expect(typeof event.seq).toBe("number");
    }
    const run_ids_a = new Set(
      events.filter((event) => event.session_id === a.session_id).map((event) => event.run_id),
    );
    const run_ids_b = new Set(
      events.filter((event) => event.session_id === b.session_id).map((event) => event.run_id),
    );
    expect(run_ids_a.size).toBe(1);
    expect(run_ids_b.size).toBe(1);
    expect([...run_ids_a][0]).not.toBe([...run_ids_b][0]);
  });
});

describe("serve prompt over websocket", () => {
  it("pushes event notifications before the submit result", async () => {
    const work_dir = await make_temp_dir("serve-prompt-ws");
    const session_dir = path.join(work_dir, "sessions");
    const agent = mock_agent(
      work_dir,
      scripted_fetch([completion_body({ role: "assistant", content: "hello" }, "stop")]),
    );
    const server = create_serve_server({
      port: 0,
      boot_stdout: null,
      session_dir,
      agent,
      version: "9.9.9",
    });
    servers.push(server);
    const boot = await server.start();

    const ws = await open_ws(`ws://127.0.0.1:${boot.port}/?token=${encodeURIComponent(boot.token)}`);
    try {
      const create_resp = await request_rpc(ws, {
        jsonrpc: "2.0",
        id: 1,
        method: "session.create",
        params: { source: "ossuary" },
      });
      const session_id = (create_resp.result as { session_id: string }).session_id;

      const messages: Array<Record<string, unknown>> = [];
      const done = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("ws prompt timeout")), 10_000);
        ws.on("message", (data) => {
          const body = JSON.parse(String(data)) as Record<string, unknown>;
          messages.push(body);
          if (body.id === 2) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "prompt.submit",
          params: { session_id, text: "hi" },
        }),
      );
      await done;

      const events = messages.filter((message) => message.method === "event");
      const result_msg = messages.find((message) => message.id === 2);
      expect(events.length).toBeGreaterThan(0);
      expect(events[0]?.params).toMatchObject({ session_id });
      expect(result_msg?.result).toMatchObject({
        session_id,
        reply: "hello",
        stopped_reason: "final",
      });
      const result_index = messages.findIndex((message) => message.id === 2);
      const last_event_index = messages.map((message) => message.method).lastIndexOf("event");
      expect(last_event_index).toBeLessThan(result_index);
    } finally {
      ws.close();
    }
  });

  it("prompt.abort cancels an in-flight submit on the same websocket", async () => {
    const work_dir = await make_temp_dir("serve-ws-abort");
    const session_dir = path.join(work_dir, "sessions");
    let fetch_started!: () => void;
    const started = new Promise<void>((resolve) => {
      fetch_started = resolve;
    });
    const fetch_fn: typeof fetch = async (_url, init) => {
      fetch_started();
      const signal = init?.signal;
      await new Promise<void>((_resolve, reject) => {
        const fail = (): void => {
          const error = new Error("fetch aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (signal?.aborted === true) {
          fail();
          return;
        }
        signal?.addEventListener("abort", fail, { once: true });
      });
      throw new Error("unreachable");
    };
    const agent = mock_agent(work_dir, fetch_fn);
    const server = create_serve_server({
      port: 0,
      boot_stdout: null,
      session_dir,
      agent,
      version: "9.9.9",
    });
    servers.push(server);
    const boot = await server.start();
    const ws = await open_ws(`ws://127.0.0.1:${boot.port}/?token=${encodeURIComponent(boot.token)}`);
    try {
      const create_resp = await request_rpc(ws, {
        jsonrpc: "2.0",
        id: 1,
        method: "session.create",
        params: { source: "test" },
      });
      const session_id = (create_resp.result as { session_id: string }).session_id;
      const submit_promise = request_rpc(ws, {
        jsonrpc: "2.0",
        id: 2,
        method: "prompt.submit",
        params: { session_id, text: "hang" },
      });
      await started;
      const abort_resp = await request_rpc(ws, {
        jsonrpc: "2.0",
        id: 3,
        method: "prompt.abort",
        params: { session_id },
      });
      expect(abort_resp.result).toEqual({ session_id, aborted: true });
      const submit = await submit_promise;
      expect(submit.result).toMatchObject({ session_id, stopped_reason: "aborted" });
    } finally {
      ws.close();
    }
  });

  it("stop() aborts an in-flight prompt instead of draining the model call", async () => {
    const work_dir = await make_temp_dir("serve-stop-abort");
    const session_dir = path.join(work_dir, "sessions");
    let fetch_started!: () => void;
    const started = new Promise<void>((resolve) => {
      fetch_started = resolve;
    });
    const fetch_fn: typeof fetch = async (_url, init) => {
      fetch_started();
      const signal = init?.signal;
      await new Promise<void>((_resolve, reject) => {
        const fail = (): void => {
          const error = new Error("fetch aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (signal?.aborted === true) {
          fail();
          return;
        }
        signal?.addEventListener("abort", fail, { once: true });
      });
      throw new Error("unreachable");
    };
    const agent = mock_agent(work_dir, fetch_fn);
    const server = create_serve_server({
      port: 0,
      boot_stdout: null,
      session_dir,
      agent,
      version: "9.9.9",
    });
    servers.push(server);
    const boot = await server.start();

    const ws = await open_ws(`ws://127.0.0.1:${boot.port}/?token=${encodeURIComponent(boot.token)}`);
    try {
      const create_resp = await request_rpc(ws, {
        jsonrpc: "2.0",
        id: 1,
        method: "session.create",
        params: { source: "test" },
      });
      const session_id = (create_resp.result as { session_id: string }).session_id;
      // Fire-and-forget: the reply may be lost to the concurrent close handshake.
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "prompt.submit",
          params: { session_id, text: "hang" },
        }),
      );
      await started;
      const t0 = Date.now();
      await server.stop();
      // Without prompts.abort_all() the drain would wait out the hanging fetch.
      expect(Date.now() - t0).toBeLessThan(5000);
    } finally {
      ws.close();
    }
  });
});

describe("run_serve signal cleanup", () => {
  it("removes SIGINT/SIGTERM handlers when start() rejects", async () => {
    const once_spy = vi.spyOn(process, "once");
    const off_spy = vi.spyOn(process, "off");
    try {
      // Empty providers fails config parsing inside create_agent_with_plugins,
      // so start() rejects before binding any port.
      const bad_config = { providers: [] } as unknown as AgentConfig;
      await expect(run_serve(bad_config, {})).rejects.toThrow();
      for (const signal of ["SIGINT", "SIGTERM"]) {
        const once_call = once_spy.mock.calls.find((call) => String(call[0]) === signal);
        expect(once_call).toBeDefined();
        const listener = once_call?.[1];
        expect(off_spy.mock.calls.some((call) => call[0] === signal && call[1] === listener)).toBe(
          true,
        );
      }
    } finally {
      once_spy.mockRestore();
      off_spy.mockRestore();
    }
  });
});

async function request_rpc(
  ws: WebSocket,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("rpc timeout")), 5000);
    const on_message = (data: WebSocket.RawData): void => {
      const body = JSON.parse(String(data)) as Record<string, unknown>;
      if (body.id !== request.id) {
        return;
      }
      clearTimeout(timer);
      ws.off("message", on_message);
      resolve(body);
    };
    ws.on("message", on_message);
    ws.send(JSON.stringify(request));
  });
}

function open_ws(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("websocket open timeout"));
    }, 5000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", () => {
      clearTimeout(timer);
      reject(new Error("websocket open failed"));
    });
  });
}
