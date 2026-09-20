/**
 * Discord adapter: gateway WebSocket (op-code switch, heartbeat, fresh
 * reconnect) plus REST replies. Token optional; absent token degrades to
 * an idle adapter. No resume support — reconnects are fresh by design.
 */
import { logger } from "../util/log.js";
import { platform_token_env, read_platform_token } from "./token_env.js";
import type { AdapterParams, PlatformAdapter, RawSocket } from "./types.js";
import { create_idle_adapter, open_socket, run_inbound_message } from "./types.js";

const DISCORD_API = "https://discord.com/api/v10";
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const INTENTS = 512 | 32768;
/** Live heartbeat timers keyed by socket, cleared when the session ends. */
const heartbeat_timers = new WeakMap<RawSocket, ReturnType<typeof setInterval>>();

type DiscordPayload = {
  op?: number;
  t?: string;
  s?: number | null;
  d?: Record<string, unknown>;
};

interface DiscordMessageData {
  content: string;
  channel_id: string;
  author_id: string;
}

export function create_discord_adapter(params: AdapterParams): PlatformAdapter {
  const token = read_platform_token(params.config, "discord");
  if (token === undefined) {
    return create_idle_adapter("discord", `${platform_token_env(params.config, "discord")} not set`);
  }
  let running = false;
  let socket: RawSocket | undefined;
  return {
    name: "discord",
    start: async () => {
      running = true;
      void connect_loop(params, token, () => running, (opened) => {
        socket = opened;
      });
    },
    stop: async () => {
      running = false;
      socket?.close();
      socket = undefined;
    },
  };
}

async function connect_loop(
  params: AdapterParams,
  token: string,
  keep_running: () => boolean,
  set_socket: (socket: RawSocket) => void,
): Promise<void> {
  while (keep_running()) {
    try {
      const socket = await open_socket(GATEWAY_URL);
      set_socket(socket);
      await socket_session(socket, token, params);
    } catch (error) {
      logger.warn("gateway discord connection failed; reconnecting in 5s", error);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

async function socket_session(socket: RawSocket, token: string, params: AdapterParams): Promise<void> {
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const done = new Promise<void>((resolve) => {
    socket.onclose = () => resolve();
  });
  socket.onmessage = (event) => {
    const payload = parse_payload(event.data);
    if (payload === undefined) {
      return;
    }
    handle_discord_payload(socket, token, params, payload);
  };
  await done;
  heartbeat = heartbeat_timers.get(socket);
  if (heartbeat !== undefined) {
    clearInterval(heartbeat);
    heartbeat_timers.delete(socket);
  }
}

function handle_discord_payload(
  socket: RawSocket,
  token: string,
  params: AdapterParams,
  payload: DiscordPayload,
): void {
  if (payload.op === 10 && is_hello(payload.d)) {
    socket.send(JSON.stringify({ op: 2, d: identify_body(token) }));
    schedule_heartbeat(socket, payload.d.heartbeat_interval);
    return;
  }
  if (payload.t === "MESSAGE_CREATE") {
    void on_message_create(params, payload.d);
  }
}

function schedule_heartbeat(
  socket: RawSocket,
  interval_ms: unknown,
): void {
  const interval = typeof interval_ms === "number" ? interval_ms : 45000;
  const timer = setInterval(() => {
    socket.send(JSON.stringify({ op: 1, d: null }));
  }, Math.max(1000, interval - 1000));
  heartbeat_timers.set(socket, timer);
}

function identify_body(token: string): Record<string, unknown> {
  return { token, intents: INTENTS, properties: { os: "linux", browser: "lich", device: "lich" } };
}

async function on_message_create(params: AdapterParams, data: Record<string, unknown> | undefined): Promise<void> {
  try {
    const message = normalize_message(data);
    if (message === undefined) {
      return;
    }
    const reply = await run_inbound_message(
      params.handle_message,
      "discord",
      message.channel_id,
      message.author_id,
      message.content,
    );
    if (reply.length === 0) {
      return;
    }
    await rest_send_message(params, message.channel_id, reply);
  } catch (error) {
    logger.warn("gateway discord deliver failed", error);
  }
}

async function rest_send_message(params: AdapterParams, channel_id: string, text: string): Promise<void> {
  const token = read_platform_token(params.config, "discord");
  if (token === undefined || channel_id === "") {
    return;
  }
  for (const chunk of split_chunks(text, 2000)) {
    const response = await fetch(`${DISCORD_API}/channels/${channel_id}/messages`, {
      method: "POST",
      headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ content: chunk }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok === false) {
      logger.warn(`gateway discord sendMessage failed with http ${response.status}`);
    }
  }
}

function normalize_message(data: Record<string, unknown> | undefined): DiscordMessageData | undefined {
  if (data === undefined) {
    return undefined;
  }
  const author = data.author;
  if (typeof author !== "object" || author === null) {
    return undefined;
  }
  const info = author as { id?: unknown; bot?: unknown };
  if (info.bot === true) {
    return undefined;
  }
  const channel_id = typeof data.channel_id === "string" ? data.channel_id : "";
  const content = strip_mention(typeof data.content === "string" ? data.content : "");
  return { channel_id, content, author_id: typeof info.id === "string" ? info.id : "" };
}

function strip_mention(content: string): string {
  const bot_id = process.env.LICH_DISCORD_BOT_ID;
  if (bot_id === undefined) {
    return content.trim();
  }
  const mention = `<@${bot_id}>`;
  return content.startsWith(mention) === true ? content.slice(mention.length).trim() : content.trim();
}

function is_hello(d: Record<string, unknown> | undefined): d is { heartbeat_interval: number } {
  return d !== undefined && typeof d.heartbeat_interval === "number";
}

function parse_payload(data: unknown): DiscordPayload | undefined {
  if (typeof data !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(data) as DiscordPayload;
  } catch {
    return undefined;
  }
}

function split_chunks(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    chunks.push(rest.slice(0, limit));
    rest = rest.slice(limit);
  }
  if (rest.length > 0) {
    chunks.push(rest);
  }
  return chunks;
}