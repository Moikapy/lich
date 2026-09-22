/**
 * Discord adapter: gateway WebSocket (op-code switch, heartbeat, fresh
 * reconnect) plus REST replies. Token optional; absent token degrades to
 * an idle adapter. No resume support — reconnects are fresh by design.
 */
import { logger } from "../util/log.js";
import { sleep } from "../util/sleep.js";
import { platform_token_env, read_platform_token } from "./token_env.js";
import type { AdapterParams, PlatformAdapter, RawSocket } from "./types.js";
import { create_idle_adapter, open_socket, run_inbound_message } from "./types.js";

const DISCORD_API = "https://discord.com/api/v10";
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
/** Guild messages + message content + direct messages. */
const INTENTS = 512 | 32768 | 4096;
export const DISCORD_BACKOFF_MS = [5000, 10000, 20000, 30000] as const;
/** Auth failure / missing privileged intents — reconnecting cannot recover. */
const DISCORD_FATAL_CLOSE = new Set([4004, 4014]);
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

interface DiscordSessionState {
  last_seq: number | null;
  identified: boolean;
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
  let backoff_index = 0;
  while (keep_running()) {
    let close_code: number | undefined;
    let identified = false;
    try {
      const socket = await open_socket(GATEWAY_URL);
      set_socket(socket);
      const session = await socket_session(socket, token, params);
      close_code = session.close_code;
      identified = session.identified;
      if (close_code !== undefined && DISCORD_FATAL_CLOSE.has(close_code)) {
        logger.warn(`gateway discord fatal close ${close_code}; stopping reconnect`);
        return;
      }
    } catch (error) {
      logger.warn("gateway discord connection failed", error);
    }
    if (keep_running() === false) {
      return;
    }
    if (identified === true) {
      backoff_index = 0;
    }
    const delay = DISCORD_BACKOFF_MS[backoff_index] ?? 30000;
    const close_note = close_code === undefined ? "" : ` (close ${close_code})`;
    logger.warn(`gateway discord reconnecting in ${delay}ms${close_note}`);
    await sleep(delay);
    backoff_index = Math.min(backoff_index + 1, DISCORD_BACKOFF_MS.length - 1);
  }
}

async function socket_session(
  socket: RawSocket,
  token: string,
  params: AdapterParams,
): Promise<{ close_code: number; identified: boolean }> {
  const state: DiscordSessionState = { last_seq: null, identified: false };
  const done = new Promise<number>((resolve) => {
    socket.onclose = ((event?: { code?: number }) => {
      resolve(typeof event?.code === "number" ? event.code : 1000);
    }) as () => void;
  });
  socket.onmessage = (event) => {
    const payload = parse_payload(event.data);
    if (payload === undefined) {
      return;
    }
    handle_discord_payload(socket, token, params, payload, state);
  };
  const close_code = await done;
  clear_heartbeat(socket);
  return { close_code, identified: state.identified };
}

function handle_discord_payload(
  socket: RawSocket,
  token: string,
  params: AdapterParams,
  payload: DiscordPayload,
  state: DiscordSessionState,
): void {
  if (typeof payload.s === "number") {
    state.last_seq = payload.s;
  }
  if (payload.op === 1) {
    send_heartbeat(socket, state.last_seq);
    return;
  }
  if (payload.op === 7 || payload.op === 9) {
    socket.close();
    return;
  }
  if (payload.op === 10 && is_hello(payload.d)) {
    socket.send(JSON.stringify({ op: 2, d: identify_body(token) }));
    state.identified = true;
    schedule_heartbeat(socket, payload.d.heartbeat_interval, () => state.last_seq);
    return;
  }
  if (payload.t === "MESSAGE_CREATE") {
    void on_message_create(params, payload.d);
  }
}

function schedule_heartbeat(
  socket: RawSocket,
  interval_ms: unknown,
  get_seq: () => number | null,
): void {
  clear_heartbeat(socket);
  const interval = typeof interval_ms === "number" ? interval_ms : 45000;
  const timer = setInterval(() => {
    send_heartbeat(socket, get_seq());
  }, Math.max(1000, interval - 1000));
  heartbeat_timers.set(socket, timer);
}

function send_heartbeat(socket: RawSocket, seq: number | null): void {
  socket.send(JSON.stringify({ op: 1, d: seq }));
}

function clear_heartbeat(socket: RawSocket): void {
  const heartbeat = heartbeat_timers.get(socket);
  if (heartbeat !== undefined) {
    clearInterval(heartbeat);
    heartbeat_timers.delete(socket);
  }
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
      body: JSON.stringify({ content: chunk, allowed_mentions: { parse: [] } }),
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
