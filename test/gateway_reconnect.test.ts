/**
 * Gateway reconnect regressions: backoff resets only after session proof,
 * fatal Discord closes stop the loop, missed heartbeat acks drop the socket,
 * and Twitch chunk splits cannot reintroduce a command marker.
 * Sleep is mocked so backoff waits stay deterministic. Heartbeat cases use
 * the adapter's real 1s floor and poll until the socket changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse_agent_config } from "../src/agent/config.js";
import { DISCORD_BACKOFF_MS, create_discord_adapter } from "../src/gateway/discord.js";
import { TWITCH_BACKOFF_MS, TWITCH_MESSAGE_CAP, create_twitch_adapter } from "../src/gateway/twitch.js";
import type { AdapterParams, PlatformAdapter, RawSocket } from "../src/gateway/types.js";

interface PendingSleep {
  ms: number;
  aborted: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
}

const { sleep_calls } = vi.hoisted(() => ({
  sleep_calls: [] as PendingSleep[],
}));

vi.mock("../src/util/sleep.js", () => ({
  sleep: (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new Error("sleep_aborted"));
        return;
      }
      if (ms < 5000) {
        resolve();
        return;
      }
      const pending: PendingSleep = { ms, aborted: false, resolve, reject };
      sleep_calls.push(pending);
      signal?.addEventListener(
        "abort",
        () => {
          pending.aborted = true;
          reject(new Error("sleep_aborted"));
        },
        { once: true },
      );
    }),
}));

const ENV_KEYS = [
  "LICH_DISCORD_BOT_TOKEN",
  "LICH_TWITCH_OAUTH_TOKEN",
  "LICH_TWITCH_NICK",
  "LICH_TWITCH_CHANNELS",
] as const;
const FATAL_DISCORD_CLOSES = [4004, 4010, 4011, 4012, 4013, 4014] as const;

class FakeSocket implements RawSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;
  close_code = 1000;

  send(data: string): void {
    this.sent.push(data);
  }

  open(): void {
    this.onopen?.();
  }

  receive(data: string): void {
    this.onmessage?.({ data });
  }

  close(): void {
    if (this.closed === true) {
      return;
    }
    this.closed = true;
    const notify = this.onclose as unknown as ((event?: { code?: number }) => void) | null;
    notify?.({ code: this.close_code });
  }
}

const sockets: FakeSocket[] = [];
let active: PlatformAdapter | undefined;
let saved_env = new Map<string, string | undefined>();
let original_websocket: typeof globalThis.WebSocket | undefined;

beforeEach(() => {
  sockets.length = 0;
  sleep_calls.length = 0;
  saved_env = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  original_websocket = globalThis.WebSocket;
  install_fake_websocket();
});

afterEach(async () => {
  await active?.stop();
  active = undefined;
  globalThis.WebSocket = original_websocket as typeof WebSocket;
  for (const key of ENV_KEYS) {
    const value = saved_env.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("gateway reconnect", () => {
  it("climbs discord backoff on hello without READY, then resets after READY", async () => {
    process.env.LICH_DISCORD_BOT_TOKEN = "test-discord-token";
    const adapter = create_discord_adapter(base_params());
    active = adapter;
    await adapter.start();

    await finish_discord_socket(0, false);
    expect((await wait_for_sleep(0)).ms).toBe(DISCORD_BACKOFF_MS[0]);
    sleep_calls[0]?.resolve();

    await finish_discord_socket(1, false);
    expect((await wait_for_sleep(1)).ms).toBe(DISCORD_BACKOFF_MS[1]);
    sleep_calls[1]?.resolve();

    await finish_discord_socket(2, true);
    const reset = await wait_for_sleep(2);
    expect(reset.ms).toBe(DISCORD_BACKOFF_MS[0]);
    await adapter.stop();
    await flush_microtasks();
    expect(reset.aborted).toBe(true);
    expect(sockets).toHaveLength(3);
  });

  it("does not reconnect after a fatal discord close", async () => {
    process.env.LICH_DISCORD_BOT_TOKEN = "test-discord-token";
    for (const code of FATAL_DISCORD_CLOSES) {
      await active?.stop();
      active = undefined;
      sockets.length = 0;
      sleep_calls.length = 0;
      const adapter = create_discord_adapter(base_params());
      active = adapter;
      await adapter.start();
      const socket = await socket_at(0);
      socket.close_code = code;
      socket.open();
      await flush_microtasks();
      socket.close();
      await flush_microtasks();
      expect({ code, sleeps: sleep_calls.length, opened: sockets.length }).toEqual({
        code,
        sleeps: 0,
        opened: 1,
      });
    }
  });

  it("closes a discord socket when a heartbeat ack never arrives", async () => {
    const socket = await open_discord_session();
    socket.receive(JSON.stringify({ op: 10, d: { heartbeat_interval: 2000 } }));
    await wait_until(() => socket.closed === true);
    expect(socket.sent).toContain(JSON.stringify({ op: 1, d: null }));
  });

  it("keeps a discord socket open when heartbeat acks arrive", async () => {
    const socket = await open_discord_session();
    socket.receive(JSON.stringify({ op: 10, d: { heartbeat_interval: 2000 } }));
    const first_beat = JSON.stringify({ op: 1, d: null });
    await wait_until(() => socket.sent.includes(first_beat));
    socket.receive(JSON.stringify({ op: 11 }));
    const sent_at_ack = socket.sent.length;
    await wait_until(() => socket.sent.length > sent_at_ack);
    expect(socket.closed).toBe(false);
    expect(socket.sent.at(-1)).toBe(first_beat);
  });

  it("climbs twitch backoff until IRC welcome, then resets", async () => {
    const adapter = start_twitch(async () => "ok");
    await adapter.start();

    await finish_twitch_socket(0, false);
    expect((await wait_for_sleep(0)).ms).toBe(TWITCH_BACKOFF_MS[0]);
    sleep_calls[0]?.resolve();

    await finish_twitch_socket(1, false);
    expect((await wait_for_sleep(1)).ms).toBe(TWITCH_BACKOFF_MS[1]);
    sleep_calls[1]?.resolve();

    await finish_twitch_socket(2, true);
    expect((await wait_for_sleep(2)).ms).toBe(TWITCH_BACKOFF_MS[0]);
  });

  it("strips a command marker that lands at the start of a twitch chunk", async () => {
    const reply = `${"a".repeat(TWITCH_MESSAGE_CAP)}/timeout viewer`;
    const adapter = start_twitch(async () => reply);
    await adapter.start();
    const socket = await socket_at(0);
    socket.open();
    await flush_microtasks();
    socket.receive(":viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #demo :hello\r\n");
    await wait_until(() => socket.sent.filter((line) => line.startsWith("PRIVMSG")).length === 2);
    const privmsgs = socket.sent.filter((line) => line.startsWith("PRIVMSG"));
    expect(privmsgs[1]).toBe("PRIVMSG #demo :timeout viewer");
  });
});

function install_fake_websocket(): void {
  const ctor = function FakeWebSocket(_url: string): FakeSocket {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  globalThis.WebSocket = ctor as unknown as typeof WebSocket;
}

function base_params(handle_message?: AdapterParams["handle_message"]): AdapterParams {
  return {
    config: parse_agent_config({
      providers: [{ kind: "openai_compat", name: "main", model: "mock-model" }],
    }),
    handle_message: handle_message ?? (async () => "ok"),
    get_agent: () => {
      throw new Error("not used");
    },
    reply_router: () => undefined,
  };
}

function start_twitch(handle_message: AdapterParams["handle_message"]): PlatformAdapter {
  process.env.LICH_TWITCH_OAUTH_TOKEN = "test-twitch-token";
  process.env.LICH_TWITCH_NICK = "lichbot";
  process.env.LICH_TWITCH_CHANNELS = "demo";
  const adapter = create_twitch_adapter(base_params(handle_message));
  active = adapter;
  return adapter;
}

async function open_discord_session(): Promise<FakeSocket> {
  process.env.LICH_DISCORD_BOT_TOKEN = "test-discord-token";
  const adapter = create_discord_adapter(base_params());
  active = adapter;
  await adapter.start();
  const socket = await socket_at(0);
  socket.open();
  await flush_microtasks();
  return socket;
}

async function finish_discord_socket(index: number, ready: boolean): Promise<void> {
  const socket = await socket_at(index);
  socket.close_code = 1006;
  socket.open();
  await flush_microtasks();
  socket.receive(JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } }));
  if (ready === true) {
    socket.receive(JSON.stringify({ t: "READY", s: 1 }));
  }
  socket.close();
}

async function finish_twitch_socket(index: number, welcomed: boolean): Promise<void> {
  const socket = await socket_at(index);
  socket.close_code = 1006;
  socket.open();
  await flush_microtasks();
  if (welcomed === true) {
    socket.receive(":tmi.twitch.tv 001 lichbot :Welcome, GLHF!\r\n");
  }
  socket.close();
}

async function socket_at(index: number): Promise<FakeSocket> {
  await wait_until(() => sockets.length > index);
  const socket = sockets[index];
  if (socket === undefined) {
    throw new Error(`missing socket ${index}`);
  }
  return socket;
}

async function wait_for_sleep(index: number): Promise<PendingSleep> {
  await wait_until(() => sleep_calls.length > index);
  const pending = sleep_calls[index];
  if (pending === undefined) {
    throw new Error(`missing sleep ${index}`);
  }
  return pending;
}

async function flush_microtasks(): Promise<void> {
  for (let step = 0; step < 6; step += 1) {
    await Promise.resolve();
  }
}

async function wait_until(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (ready() === true) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for gateway condition");
}
