/**
 * Twitch adapter: IRC-over-WebSocket on irc-ws.chat.twitch.tv. Handles
 * CAP/JOIN setup, tag-prefixed PRIVMSG parsing, PING/PONG, and 512-char
 * message splitting. Absent config degrades to an idle adapter.
 */
import type { AgentConfig } from "../agent/config.js";
import { logger } from "../util/log.js";
import { platform_token_env, read_platform_token } from "./token_env.js";
import type { AdapterParams, PlatformAdapter, RawSocket } from "./types.js";
import { create_idle_adapter, open_socket, run_inbound_message } from "./types.js";

export const TWITCH_IRC_URL = "wss://irc-ws.chat.twitch.tv:443";
export const TWITCH_MESSAGE_CAP = 512;

interface TwitchConfig {
  token: string;
  nick: string;
  channels: string[];
}

interface ParsedLine {
  kind: "ping" | "privmsg" | "other";
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
  return {
    name: "twitch",
    start: async () => {
      running = true;
      void irc_loop(params, twitch, () => running, (opened) => {
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
): Promise<void> {
  while (keep_running()) {
    try {
      const socket = await open_socket(TWITCH_IRC_URL);
      set_socket(socket);
      await irc_session(params, twitch, socket, keep_running);
    } catch (error) {
      logger.warn("gateway twitch connection failed; reconnecting in 5s", error);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

async function irc_session(
  params: AdapterParams,
  twitch: TwitchConfig,
  socket: RawSocket,
  keep_running: () => boolean,
): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    socket.onclose = () => resolve();
  });
  socket.onmessage = (event) => {
    for (const line of String(event.data).split("\r\n")) {
      void handle_irc_line(params, twitch, socket, line);
    }
  };
  socket.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
  socket.send(`PASS ${twitch.token}`);
  socket.send(`NICK ${twitch.nick}`);
  for (const channel of twitch.channels) {
    socket.send(`JOIN #${channel}`);
  }
  await closed;
}

async function handle_irc_line(
  params: AdapterParams,
  twitch: TwitchConfig,
  socket: RawSocket,
  line: string,
): Promise<void> {
  if (line.length === 0) {
    return;
  }
  const parsed = parse_irc_line(line);
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
  send_twitch_message(socket, parsed.channel, reply);
}

function send_twitch_message(socket: RawSocket, channel: string, text: string): void {
  for (const chunk of split_chunks(text, TWITCH_MESSAGE_CAP)) {
    socket.send(`PRIVMSG #${channel} :${chunk}`);
  }
}

export function parse_irc_line(line: string): ParsedLine {
  if (line.startsWith("PING") === true) {
    return { kind: "ping", channel: "", user: "", text: "" };
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