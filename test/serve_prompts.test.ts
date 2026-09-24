/**
 * Serve prompt.submit / abort: events, final reply, abort, one SessionHandle transcript.
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { create_agent } from "../src/agent/agent.js";
import type { AgentEvent } from "../src/agent/events.js";
import { handle_serve_rpc_message, type ServeRpcContext } from "../src/serve/rpc.js";
import { create_serve_prompt_service } from "../src/serve/prompts.js";
import { create_serve_server, type ServeServer } from "../src/serve/server.js";
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
    const payload = error_event.error as { name?: unknown; message?: unknown };
    expect(typeof payload.name).toBe("string");
    expect(typeof payload.message).toBe("string");
    expect(String(payload.message).length).toBeGreaterThan(0);
    expect(Object.keys(payload).sort()).toEqual(["message", "name"]);
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
