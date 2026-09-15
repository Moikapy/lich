/**
 * Shared contracts for the messaging gateway: platform message shapes,
 * reply sinks, adapter lifecycle, and the small runtime helpers every
 * platform adapter shares (idle fallback, raw WebSocket, inbound dispatch).
 */
import type { Agent } from "../agent/agent.js";
import type { AgentConfig } from "../agent/config.js";
import { logger } from "../util/log.js";

export type PlatformName = "webhook" | "telegram" | "discord" | "twitch";

/** Normalized inbound message from any supported platform. */
export interface PlatformMessage {
  platform: PlatformName;
  chat_id: string;
  user_id: string;
  text: string;
}

/** Outbound-only view used to deliver a reply to a conversation. */
export interface ReplySink {
  send(text: string): Promise<void>;
}

/** Lifecycle contract implemented by every platform adapter. */
export interface PlatformAdapter {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Handles one inbound message and resolves to the reply text. */
export type InboundHandler = (
  platform: string,
  chat_id: string,
  user_id: string,
  text: string,
) => Promise<string | undefined>;

/** Dependencies handed to every adapter factory. */
export interface AdapterParams {
  config: AgentConfig;
  handle_message: InboundHandler;
  get_agent: () => Agent;
  reply_router: (platform: string, chat_id: string) => ReplySink | undefined;
}

/** Minimal structural WebSocket surface shared by bun and node runtimes. */
export interface RawSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

const ERROR_SNIPPET_CHARS = 300;

/** Flattens a failure into a single-line, bounded, safe reply string. */
export function sanitize_agent_error(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const flat = raw.replace(/\s+/g, " ").trim();
  return `agent error: ${flat.slice(0, ERROR_SNIPPET_CHARS) || "unknown"}`;
}

/** Adapter that logs why it is idle once and otherwise does nothing. */
export function create_idle_adapter(name: string, reason: string): PlatformAdapter {
  logger.warn(`gateway ${name} adapter idle: ${reason}`);
  return {
    name,
    start: async () => undefined,
    stop: async () => undefined,
  };
}

/** Opens a WebSocket and resolves once connected; rejects on open error. */
export function open_socket(url: string): Promise<RawSocket> {
  return new Promise((resolve, reject) => {
    const ctor = (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket;
    if (ctor === undefined) {
      reject(new Error("runtime does not expose a WebSocket constructor"));
      return;
    }
    const socket = new ctor(url) as unknown as RawSocket;
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error(`websocket connect failed: ${url}`));
  });
}

/** Runs one inbound message, converting failures into a safe reply string. */
export async function run_inbound_message(
  handle: InboundHandler,
  platform: string,
  chat_id: string,
  user_id: string,
  text: string,
): Promise<string> {
  try {
    return (await handle(platform, chat_id, user_id, text)) ?? "";
  } catch (error) {
    logger.error(`gateway ${platform} message handling failed`, error);
    return sanitize_agent_error(error);
  }
}