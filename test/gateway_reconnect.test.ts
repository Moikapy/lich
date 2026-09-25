/**
 * Discord/Twitch reconnect proof: backoff resets only after a real session,
 * fatal Discord closes stop the loop, and a missed heartbeat ack drops the socket.
 * Sleep is scripted so the suite never waits on the 5–30s production delays.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse_agent_config } from "../src/agent/config.js";
import { create_discord_adapter } from "../src/gateway/discord.js";
import { create_twitch_adapter } from "../src/gateway/twitch.js";
import type { AdapterParams } from "../src/gateway/types.js";

const sleep_state = vi.hoisted(() => ({
  delays: [] as number[],
  pending: [] as Array<{ resolve: () => void; reject: (error: Error) => void }>,
}));

vi.mock("../src/util/sleep.js", () => ({
  sleep: (ms: number, signal?: AbortSignal): Promise<void> => {
    sleep_state.delays.push(ms);
    return new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new Error("sleep_aborted"));
        return;
      }
      const on_abort = (): void => {
        reject(new Error("sleep_aborted"));
      };
      signal?.addEventListener("abort", on_abort, { once: true });
      sleep_state.pending.push({
        resolve: () => {
          signal?.removeEventListener("abort", on_abort);
          resolve();
        },
        reject: (error: Error) => {
          signal?.removeEventListener("abort", on_abort);
          reject(error);
        },
      });
    });
  },
}));

class FakeSocket {
  static sockets: FakeSocket[] = [];
  sent: string[] = [];
  close_count = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(_url: string) {
    FakeSocket.sockets.push(this);
    queueMicrotask(() => {
      this.onopen?.();
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.close_count += 1;
    this.onclose?.({ code: 1000 });
  }

  server_close(code: number): void {
    this.onclose?.({ code });
  }

  emit(data: string): void {
    this.onmessage?.({ data });
  }
}

const ENV_KEYS = ["LICH_DISCORD_BOT_TOKEN", "LICH_TWITCH_OAUTH_TOKEN", "LICH_TWITCH_NICK", "LICH_TWITCH_CHANNELS"] as const;
const saved_env = new Map<string, string | undefined>();

function remember_env(): void {
  for (const key of ENV_KEYS) {
    saved_env.set(key, process.env[key]);
    delete process.env[key];
  }
}

function restore_env(): void {
  for (const key of ENV_KEYS) {
    const prior = saved_env.get(key);
    if (prior === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prior;
    }
  }
}

function adapter_params(): AdapterParams {
  return {
    config: parse_agent_config({
      providers: [{ kind: "openai_compat", name: "main", model: "mock-model" }],
      log_level: "error",
    }),
    handle_message: async () => "ok",
    get_agent: () => {
      throw new Error("not used");
    },
    reply_router: () => undefined,
  };
}

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await Promise.resolve();
  }
}

async function wait_for_socket(index: number): Promise<FakeSocket> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const socket = FakeSocket.sockets[index];
    if (socket?.onmessage !== null && socket?.onmessage !== undefined) {
      return socket;
    }
    await settle();
  }
  throw new Error(`socket ${index} did not open`);
}

function release_sleep(): void {
  const next = sleep_state.pending.shift();
  next?.resolve();
}

function heartbeat_count(socket: FakeSocket): number {
  return socket.sent.filter((line) => line.includes('"op":1')).length;
}

afterEach(() => {
  vi.useRealTimers();
  for (const entry of sleep_state.pending.splice(0)) {
    entry.reject(new Error("test_cleanup"));
  }
  sleep_state.delays.length = 0;
  FakeSocket.sockets = [];
  vi.unstubAllGlobals();
  restore_env();
});

describe("discord reconnect", () => {
  it("stops on fatal close 4010 and does not schedule another attempt", async () => {
    remember_env();
    process.env.LICH_DISCORD_BOT_TOKEN = "fixture-discord-token";
    vi.stubGlobal("WebSocket", FakeSocket);
    const adapter = create_discord_adapter(adapter_params());
    await adapter.start();
    const socket = await wait_for_socket(0);
    socket.server_close(4010);
    await settle();
    expect(sleep_state.delays).toEqual([]);
    expect(FakeSocket.sockets).toHaveLength(1);
    await adapter.stop();
  });

  it("resets backoff after READY and climbs when the session never identifies", async () => {
    remember_env();
    process.env.LICH_DISCORD_BOT_TOKEN = "fixture-discord-token";
    vi.stubGlobal("WebSocket", FakeSocket);
    const adapter = create_discord_adapter(adapter_params());
    await adapter.start();

    const first = await wait_for_socket(0);
    first.server_close(1006);
    await settle();
    expect(sleep_state.delays).toEqual([5000]);
    release_sleep();

    const second = await wait_for_socket(1);
    second.emit(JSON.stringify({ t: "READY", s: 1 }));
    second.server_close(1006);
    await settle();
    expect(sleep_state.delays).toEqual([5000, 5000]);
    release_sleep();

    const third = await wait_for_socket(2);
    third.server_close(4000);
    await settle();
    expect(sleep_state.delays).toEqual([5000, 5000, 10000]);
    await adapter.stop();
  });

  it("closes the socket when a heartbeat ack never arrives", async () => {
    remember_env();
    process.env.LICH_DISCORD_BOT_TOKEN = "fixture-discord-token";
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    const adapter = create_discord_adapter(adapter_params());
    await adapter.start();
    const socket = await wait_for_socket(0);
    socket.emit(JSON.stringify({ op: 10, d: { heartbeat_interval: 2000 } }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(heartbeat_count(socket)).toBe(1);
    expect(socket.close_count).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.close_count).toBe(1);
    expect(heartbeat_count(socket)).toBe(1);
    await adapter.stop();
  });

  it("keeps the socket open when heartbeat acks arrive", async () => {
    remember_env();
    process.env.LICH_DISCORD_BOT_TOKEN = "fixture-discord-token";
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    const adapter = create_discord_adapter(adapter_params());
    await adapter.start();
    const socket = await wait_for_socket(0);
    socket.emit(JSON.stringify({ op: 10, d: { heartbeat_interval: 2000 } }));
    await vi.advanceTimersByTimeAsync(1000);
    socket.emit(JSON.stringify({ op: 11 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.close_count).toBe(0);
    expect(heartbeat_count(socket)).toBe(2);
    await adapter.stop();
  });
});

describe("twitch reconnect", () => {
  it("resets backoff only after an IRC welcome, not a bare socket", async () => {
    remember_env();
    process.env.LICH_TWITCH_OAUTH_TOKEN = "fixture-twitch-token";
    process.env.LICH_TWITCH_NICK = "lichbot";
    process.env.LICH_TWITCH_CHANNELS = "lobby";
    vi.stubGlobal("WebSocket", FakeSocket);
    const adapter = create_twitch_adapter(adapter_params());
    await adapter.start();

    const first = await wait_for_socket(0);
    first.server_close(1006);
    await settle();
    expect(sleep_state.delays).toEqual([5000]);
    release_sleep();

    const second = await wait_for_socket(1);
    second.emit(":tmi.twitch.tv 001 lichbot :Welcome\r\n");
    second.server_close(1006);
    await settle();
    expect(sleep_state.delays).toEqual([5000, 5000]);
    release_sleep();

    const third = await wait_for_socket(2);
    third.server_close(1006);
    await settle();
    expect(sleep_state.delays).toEqual([5000, 5000, 10000]);
    await adapter.stop();
  });
});
