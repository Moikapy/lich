/**
 * Twitch adapter: IRC-over-WebSocket on irc-ws.chat.twitch.tv. Handles
 * CAP/JOIN setup, tag-prefixed PRIVMSG parsing, PING/PONG, and bounded
 * message splitting. Absent config degrades to an idle adapter.
 */
import type { AgentConfig } from "../agent/config.js";
import { logger } from "../util/log.js";
import { sleep } from "../util/sleep.js";
import { platform_token_env, read_platform_token } from "./token_env.js";
import type { AdapterParams, PlatformAdapter, RawSocket } from "./types.js";
import { create_idle_adapter, open_socket, run_inbound_message } from "./types.js";

export const TWITCH_IRC_URL = "wss://irc-ws.chat.twitch.tv:443";
/** Content budget under Twitch's 500-char message / 512-byte IRC line caps. */
export const TWITCH_MESSAGE_CAP = 450;
export const TWITCH_BACKOFF_MS = [5000, 10000, 20000, 30000] as const;
const TWITCH_CHUNK_GAP_MS = 1600;

interface TwitchConfig {
  token: string;
  nick: string;
  channels: string[];
}

interface ParsedLine {
  kind: "ping" | "privmsg" | "welcome" | "other";
  channel: string;
  user: string;
  text: string;
}

export function create_twitch_adapter(params: AdapterParams): PlatformAdapter {
  const twitch = read_twitch_env(params.config);
  if (twitch === undefined) {
    const token_env = platform_token_env(params.config, "twitch");
    const reason = token_env === "LICH_TWITCH_OAUTH_TOKEN" ? "LICH_TWITCH_OAUTH_TOKEN / NICK not set" : `${token_env} / LICH_TWITCH_NICK not set`;
    return create_idle_adapter("twitch", reason);
  }
  let running = false;
  let socket: RawSocket | undefined;
  let stop_controller = new AbortController();
  return {
    name: "twitch",
    start: async () => {
      running = true;
      stop_controller = new AbortController();
      void irc_loop(params, twitch, () => running, (opened) => {
        socket = opened;
      }, stop_controller.signal);
    },
    stop: async () => {
      running = false;
      stop_controller.abort();
      socket?.close();
      socket = undefined;
    },
  };
}

function read_twitch_env(config: AgentConfig): TwitchConfig | undefined {
  const raw_token = read_platform_token(config, "twitch");
  const nick = process.env.LICH_TWITCH_NICK;
  const channels_env = process.env.LICH_TWITCH_CHANNELS;
  if (raw_token === undefined || raw_token.length === 0 || nick === undefined || nick.length === 0) {
    return undefined;
  }
  const token = raw_token.startsWith("oauth:") === true ? raw_token : `oauth:${raw_token}`;
  const channels = (channels_env ?? "")
    .split(",")
    .map((channel) => channel.trim().toLowerCase())
    .filter((channel) => channel.length > 0);
  if (channels.length === 0) {
    return undefined;
  }
  return { token, nick, channels };
}

async function irc_loop(
  params: AdapterParams,
  twitch: TwitchConfig,
  keep_running: () => boolean,
  set_socket: (socket: RawSocket) => void,
  signal: AbortSignal,
): Promise<void> {
  let backoff_index = 0;
  while (keep_running()) {
    let close_code: number | undefined;
    let welcomed = false;
    try {
      const socket = await open_socket(TWITCH_IRC_URL);
      set_socket(socket);
      const session = await irc_session(params, twitch, socket);
      close_code = session.close_code;
      welcomed = session.welcomed;
    } catch (error) {
      logger.warn("gateway twitch connection failed", error);
    }
    if (keep_running() === false) {
      return;
    }
    if (welcomed === true) {
      backoff_index = 0;
    }
    const delay = TWITCH_BACKOFF_MS[backoff_index] ?? 30000;
    const close_note = close_code === undefined ? "" : ` (close ${close_code})`;
    logger.warn(`gateway twitch reconnecting in ${delay}ms${close_note}`);
    try {
      await sleep(delay, signal);
    } catch {
      return;
    }
    backoff_index = Math.min(backoff_index + 1, TWITCH_BACKOFF_MS.length - 1);
  }
}

async function irc_session(
  params: AdapterParams,
  twitch: TwitchConfig,
  socket: RawSocket,
): Promise<{ close_code: number; welcomed: boolean }> {
  let welcomed = false;
  const closed = new Promise<number>((resolve) => {
    socket.onclose = ((event?: { code?: number }) => {
      resolve(typeof event?.code === "number" ? event.code : 1000);
    }) as () => void;
  });
  socket.onmessage = (event) => {
    for (const line of String(event.data).split("\r\n")) {
      void handle_irc_line(params, twitch, socket, line, (ok) => {
        if (ok === true) {
          welcomed = true;
        }
      });
    }
  };
  socket.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
  socket.send(`PASS ${twitch.token}`);
  socket.send(`NICK ${twitch.nick}`);
  for (const channel of twitch.channels) {
    socket.send(`JOIN #${channel}`);
  }
  const close_code = await closed;
  return { close_code, welcomed };
}

async function handle_irc_line(
  params: AdapterParams,
  twitch: TwitchConfig,
  socket: RawSocket,
  line: string,
  on_welcome: (ok: boolean) => void,
): Promise<void> {
  if (line.length === 0) {
    return;
  }
  const parsed = parse_irc_line(line);
  if (parsed.kind === "welcome") {
    on_welcome(true);
    return;
  }
  if (parsed.kind === "ping") {
    socket.send("PONG :tmi.twitch.tv");
    return;
  }
  if (parsed.kind !== "privmsg" || parsed.user === twitch.nick) {
    return;
  }
  const reply = await run_inbound_message(
    params.handle_message,
    "twitch",
    parsed.channel,
    parsed.user,
    parsed.text,
  );
  await send_twitch_message(socket, parsed.channel, reply);
}

async function send_twitch_message(socket: RawSocket, channel: string, text: string): Promise<void> {
  const safe = sanitize_twitch_outbound(text);
  if (safe.length === 0) {
    return;
  }
  const chunks = split_chunks(safe, TWITCH_MESSAGE_CAP);
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk === undefined) {
      continue;
    }
    const sanitized_chunk = sanitize_twitch_outbound(chunk);
    if (sanitized_chunk.length === 0) {
      continue;
    }
    socket.send(`PRIVMSG #${channel} :${sanitized_chunk}`);
    if (index + 1 < chunks.length) {
      await sleep(TWITCH_CHUNK_GAP_MS);
    }
  }
}

/** Strip IRC control chars and neutralize leading Twitch chat command markers. */
export function sanitize_twitch_outbound(text: string): string {
  let cleaned = text.replace(/[\r\n]+/g, " ").trim();
  while (cleaned.startsWith("/") === true || cleaned.startsWith(".") === true) {
    cleaned = cleaned.slice(1).trimStart();
  }
  return cleaned;
}

export function parse_irc_line(line: string): ParsedLine {
  if (line.startsWith("PING") === true) {
    return { kind: "ping", channel: "", user: "", text: "" };
  }
  if (/:\S+ 001 /.test(line) === true || line.includes(" GLOBALUSERSTATE ") === true) {
    return { kind: "welcome", channel: "", user: "", text: "" };
  }
  const privmsg = match_privmsg(line);
  if (privmsg === undefined) {
    return { kind: "other", channel: "", user: "", text: "" };
  }
  return privmsg;
}

function match_privmsg(line: string): ParsedLine | undefined {
  const without_tags = line.startsWith("@") === true ? line.slice(line.indexOf(" ") + 1) : line;
  const matched = /^:(\w+)!\S+ PRIVMSG #(\w+) :(.*)$/.exec(without_tags);
  if (matched === null) {
    return undefined;
  }
  return {
    kind: "privmsg",
    user: matched[1] ?? "",
    channel: matched[2] ?? "",
    text: matched[3] ?? "",
  };
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
