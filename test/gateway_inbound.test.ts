/**
 * Inbound filters for the chat adapters: Discord mention/bot handling,
 * Twitch self-echo and command markers, Telegram update selection and
 * poll backoff. Sleep and sockets are scripted; no live network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse_agent_config } from "../src/agent/config.js";
import { create_discord_adapter } from "../src/gateway/discord.js";
import { create_telegram_adapter, TELEGRAM_BACKOFF_MS } from "../src/gateway/telegram.js";
import { create_twitch_adapter } from "../src/gateway/twitch.js";
import type { AdapterParams } from "../src/gateway/types.js";

const sleep_state = vi.hoisted(() => ({
  delays: [] as number[],
  pending: [] as Array<{ resolve: () => void }>,
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

  emit(data: string): void {
    this.onmessage?.({ data });
  }
}

const ENV_KEYS = [
  "LICH_DISCORD_BOT_TOKEN",
  "LICH_DISCORD_BOT_ID",
  "LICH_TELEGRAM_BOT_TOKEN",
  "LICH_TWITCH_OAUTH_TOKEN",
  "LICH_TWITCH_NICK",
  "LICH_TWITCH_CHANNELS",
] as const;
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

function adapter_params(handle_message: AdapterParams["handle_message"]): AdapterParams {
  return {
    config: parse_agent_config({
      providers: [{ kind: "openai_compat", name: "main", model: "mock-model" }],
      log_level: "error",
    }),
    handle_message,
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

async function wait_for(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (ready() === true) {
      return;
    }
    await settle();
  }
  throw new Error("condition not met");
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

interface ScriptedPoll {
  status: number;
  body: unknown;
}

function script_telegram_fetch(script: readonly ScriptedPoll[], sent: string[]): {
  allow_exit: () => void;
} {
  const state = { cursor: 0, allow_exit: false, release: (): void => undefined };
  const parked = new Promise<void>((resolve) => {
    state.release = resolve;
  });
  vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("getUpdates") === true) {
      const next = script[state.cursor];
      if (next !== undefined) {
        state.cursor += 1;
        return new Response(JSON.stringify(next.body), { status: next.status });
      }
      if (state.allow_exit === true) {
        return new Response(JSON.stringify({ result: [] }), { status: 200 });
      }
      await parked;
      return new Response(JSON.stringify({ result: [] }), { status: 200 });
    }
    if (typeof init?.body === "string") {
      sent.push(init.body);
    }
    return new Response("{}", { status: 200 });
  });
  return {
    allow_exit: () => {
      state.allow_exit = true;
      state.release();
    },
  };
}

function release_sleep(): void {
  const next = sleep_state.pending.shift();
  next?.resolve();
}

afterEach(() => {
  for (const entry of sleep_state.pending.splice(0)) {
    entry.resolve();
  }
  sleep_state.delays.length = 0;
  FakeSocket.sockets = [];
  vi.unstubAllGlobals();
  restore_env();
});

describe("discord inbound", () => {
  it("ignores bots, strips only a leading mention, and posts with mentions disabled", async () => {
    remember_env();
    process.env.LICH_DISCORD_BOT_TOKEN = "fixture-discord-token";
    process.env.LICH_DISCORD_BOT_ID = "999";
    const seen: string[] = [];
    const posts: Array<{ content?: string; allowed_mentions?: unknown; authorization?: string }> = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as { authorization?: string } | undefined;
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        content?: string;
        allowed_mentions?: unknown;
      };
      posts.push({ ...body, authorization: headers?.authorization });
      return new Response("{}", { status: 200 });
    });
    const adapter = create_discord_adapter(adapter_params(async (_platform, _chat, user, text) => {
      seen.push(`${user}:${text}`);
      return text.length === 0 ? "" : `echo ${text}`;
    }));
    await adapter.start();
    const socket = await wait_for_socket(0);
    const emit = (data: Record<string, unknown>): void => {
      socket.emit(JSON.stringify({ t: "MESSAGE_CREATE", d: data }));
    };
    emit({ channel_id: "c1", content: "<@999> hello", author: { id: "u1", bot: false } });
    emit({ channel_id: "c1", content: "hi <@999>", author: { id: "u2", bot: false } });
    emit({ channel_id: "c1", content: "from bot", author: { id: "b1", bot: true } });
    emit({ channel_id: "c1", content: "no author" });
    emit({ channel_id: "c1", content: "<@999>", author: { id: "u3", bot: false } });
    await wait_for(() => seen.length === 3 && posts.length === 2);
    expect(seen).toEqual(["u1:hello", "u2:hi <@999>", "u3:"]);
    expect(posts.map((post) => post.content)).toEqual(["echo hello", "echo hi <@999>"]);
    expect(posts[0]?.allowed_mentions).toEqual({ parse: [] });
    expect(posts[0]?.authorization).toBe("Bot fixture-discord-token");
    expect(socket.close_count).toBe(0);
    await adapter.stop();
  });

  it("posts a one-line agent error when the handler throws", async () => {
    remember_env();
    process.env.LICH_DISCORD_BOT_TOKEN = "fixture-discord-token";
    const posts: string[] = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { content?: string };
      if (typeof body.content === "string") {
        posts.push(body.content);
      }
      return new Response("{}", { status: 500 });
    });
    const adapter = create_discord_adapter(adapter_params(async () => {
      throw new Error("boom\nline");
    }));
    await adapter.start();
    const socket = await wait_for_socket(0);
    socket.emit(JSON.stringify({
      t: "MESSAGE_CREATE",
      d: { channel_id: "c1", content: "hi", author: { id: "u1", bot: false } },
    }));
    await wait_for(() => posts.length === 1);
    expect(posts[0]).toBe("agent error: boom line");
    expect(socket.close_count).toBe(0);
    await adapter.stop();
  });
});

describe("twitch inbound", () => {
  it("ignores its own nick and strips a leading command marker before sending", async () => {
    remember_env();
    process.env.LICH_TWITCH_OAUTH_TOKEN = "fixture-twitch-token";
    process.env.LICH_TWITCH_NICK = "lichbot";
    process.env.LICH_TWITCH_CHANNELS = "Lobby";
    const seen: string[] = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    const adapter = create_twitch_adapter(adapter_params(async (_platform, channel, user, text) => {
      seen.push(`${channel}:${user}:${text}`);
      return text === "dot" ? "." : "/ban everyone";
    }));
    await adapter.start();
    const socket = await wait_for_socket(0);
    expect(socket.sent).toContain("PASS oauth:fixture-twitch-token");
    expect(socket.sent).toContain("JOIN #lobby");
    socket.emit(
      ":lichbot!lichbot@lichbot.tmi.twitch.tv PRIVMSG #lobby :self\r\n" +
        ":viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #lobby :hello\r\n" +
        ":viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #lobby :dot\r\n",
    );
    const bodies = (): string[] =>
      socket.sent.filter((line) => line.startsWith("PRIVMSG #")).map((line) => line.slice(line.indexOf(" :") + 2));
    await wait_for(() => bodies().length === 1 && seen.length === 2);
    expect(seen).toEqual(["lobby:viewer:hello", "lobby:viewer:dot"]);
    expect(bodies()).toEqual(["ban everyone"]);
    await adapter.stop();
  });

  it("does not double the oauth prefix when the token already has one", async () => {
    remember_env();
    process.env.LICH_TWITCH_OAUTH_TOKEN = "oauth:already";
    process.env.LICH_TWITCH_NICK = "lichbot";
    process.env.LICH_TWITCH_CHANNELS = "lobby";
    vi.stubGlobal("WebSocket", FakeSocket);
    const adapter = create_twitch_adapter(adapter_params(async () => ""));
    await adapter.start();
    const socket = await wait_for_socket(0);
    expect(socket.sent).toContain("PASS oauth:already");
    expect(socket.sent.some((line) => line.includes("oauth:oauth:"))).toBe(false);
    await adapter.stop();
  });
});

describe("telegram inbound", () => {
  it("skips bots and chat-less updates, and treats a non-array result as empty", async () => {
    remember_env();
    process.env.LICH_TELEGRAM_BOT_TOKEN = "fixture-telegram-token";
    const seen: string[] = [];
    const sent: string[] = [];
    const polls = script_telegram_fetch(
      [
        { status: 200, body: { result: { bad: true } } },
        {
          status: 200,
          body: {
            result: [
              { update_id: 1, message: { text: "nope", chat: { id: 9 }, from: { id: 1, is_bot: true } } },
              { update_id: 2, message: { text: "orphan", from: { id: 2 } } },
              { update_id: 3, message: { chat: { id: 0 }, from: { id: 0 } } },
              { update_id: 4, message: { text: "hi", chat: { id: 7 }, from: { id: 4 } } },
            ],
          },
        },
      ],
      sent,
    );
    const adapter = create_telegram_adapter(adapter_params(async (_platform, chat, user, text) => {
      seen.push(`${chat}:${user}:${text}`);
      return `echo ${text}`;
    }));
    try {
      await adapter.start();
      await wait_for(() => sent.length === 2 && seen.length === 2);
      expect(sleep_state.delays).toEqual([]);
      expect(seen).toEqual(["0:0:media not supported yet", "7:4:hi"]);
      expect(sent.map((body) => JSON.parse(body) as { chat_id: string; text: string })).toEqual([
        { chat_id: "0", text: "echo media not supported yet" },
        { chat_id: "7", text: "echo hi" },
      ]);
    } finally {
      await adapter.stop();
      polls.allow_exit();
    }
  });

  it("backs off on a failed poll and resets after the next success", async () => {
    remember_env();
    process.env.LICH_TELEGRAM_BOT_TOKEN = "fixture-telegram-token";
    const sent: string[] = [];
    const polls = script_telegram_fetch(
      [
        { status: 500, body: {} },
        {
          status: 200,
          body: { result: [{ update_id: 1, message: { text: "hi", chat: { id: 3 }, from: { id: 8 } } }] },
        },
        { status: 502, body: {} },
      ],
      sent,
    );
    const adapter = create_telegram_adapter(adapter_params(async () => "ok"));
    try {
      await adapter.start();
      await wait_for(() => sleep_state.delays.length === 1);
      expect(sleep_state.delays).toEqual([TELEGRAM_BACKOFF_MS[0]]);
      release_sleep();
      await wait_for(() => sent.length === 1 && sleep_state.delays.length === 2);
      expect(sleep_state.delays).toEqual([TELEGRAM_BACKOFF_MS[0], TELEGRAM_BACKOFF_MS[0]]);
      expect(JSON.parse(sent[0] ?? "{}")).toEqual({ chat_id: "3", text: "ok" });
    } finally {
      await adapter.stop();
      release_sleep();
      polls.allow_exit();
    }
  });
});
