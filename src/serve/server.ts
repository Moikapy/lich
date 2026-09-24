/**
 * Loopback WebSocket JSON-RPC transport for `lich serve`.
 * Token-gated upgrade; emits one machine-readable boot JSON line.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { LICH_VERSION } from "../version.js";
import { create_agent_with_plugins, type Agent } from "../agent/agent.js";
import type { AgentConfig } from "../agent/config.js";
import { logger } from "../util/log.js";
import { create_serve_prompt_service, type ServePromptService } from "./prompts.js";
import { handle_serve_rpc_message } from "./rpc.js";
import { create_serve_session_store, type ServeSessionStore } from "./sessions.js";
import type { ServeEventNotification } from "./protocol.js";

export const DEFAULT_SERVE_HOST = "127.0.0.1";
export const DEFAULT_SERVE_PORT = 0;
const TOKEN_BYTES = 24;
const MAX_PAYLOAD_BYTES = 1 << 20;
const CLOSE_GRACE_MS = 1000;

export interface ServeBootInfo {
  port: number;
  token: string;
}

export interface ServeOptions {
  /** Bind address; must be loopback. Default `127.0.0.1`. */
  host?: string;
  /** TCP port; `0` = ephemeral. Default `0`. */
  port?: number;
  /** Shared secret; generated when omitted. */
  token?: string;
  /** Reported by `health`; defaults to `LICH_VERSION`. */
  version?: string;
  /** Transcript directory for session.list / resume / create. */
  session_dir?: string;
  /** LRU cap for in-memory session bags; `0` disables. Default 32. */
  max_session_bags?: number;
  /** Injected Agent (tests). Takes precedence over `agent_config`. */
  agent?: Agent;
  /** Parsed like CLI config; used when `agent` is omitted. Creates via create_agent_with_plugins. */
  agent_config?: unknown;
  /** Boot JSON line sink. Default `process.stdout`; `null` skips emission. */
  boot_stdout?: NodeJS.WritableStream | null;
  on_listening?: (info: ServeBootInfo) => void;
}

export interface ServeServer {
  start(): Promise<ServeBootInfo>;
  stop(): Promise<void>;
  readonly boot: ServeBootInfo | undefined;
  readonly sessions: ServeSessionStore;
  readonly prompts: ServePromptService | undefined;
}

/**
 * CLI entry: bind loopback with the same Agent config as `lich tui` / chat,
 * emit boot JSON, then stay alive until SIGINT/SIGTERM.
 */
export async function run_serve(
  config: AgentConfig,
  options: { host?: string; port?: number } = {},
): Promise<number> {
  const server = create_serve_server({
    host: options.host,
    port: options.port,
    agent_config: config,
    session_dir: config.session_dir,
  });
  const shutdown = (): void => {
    void server.stop().finally(() => {
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await server.start();
  } catch (error) {
    // Detach the handlers and tear down the partial server so start() failure
    // does not leak them (or a half-listening socket) for the process lifetime.
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await server.stop().catch(() => undefined);
    throw error;
  }
  return await new Promise<number>(() => undefined);
}

export function create_serve_server(options: ServeOptions = {}): ServeServer {
  const host = options.host ?? DEFAULT_SERVE_HOST;
  const want_port = options.port ?? DEFAULT_SERVE_PORT;
  const token = options.token ?? randomBytes(TOKEN_BYTES).toString("hex");
  const version = options.version ?? LICH_VERSION;
  const session_dir = options.session_dir ?? path.join(process.cwd(), ".lich", "sessions");
  const sessions = create_serve_session_store(session_dir, options.max_session_bags);
  assert_loopback_host(host);

  let http_server: Server | undefined;
  let wss: WebSocketServer | undefined;
  let boot: ServeBootInfo | undefined;
  let prompts: ServePromptService | undefined;
  let owned_agent: Agent | undefined;
  let stopping = false;
  /** Enqueued handler chains; stop() drains this before sessions.dispose(). */
  const inflight = new Set<Promise<void>>();

  return {
    get boot() {
      return boot;
    },
    get sessions() {
      return sessions;
    },
    get prompts() {
      return prompts;
    },
    start: async () => {
      if (http_server !== undefined) {
        throw new Error("lich serve already started");
      }
      stopping = false;
      const agent = await resolve_agent(options);
      if (agent !== undefined && options.agent === undefined) {
        owned_agent = agent;
      }
      prompts = agent === undefined ? undefined : create_serve_prompt_service(agent, sessions);
      http_server = createServer((_req, res) => {
        res.statusCode = 404;
        res.end();
      });
      wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
      http_server.on("upgrade", (request, socket, head) => {
        // Defense-in-depth for pre-upgrade reject writes (403/401): the sync
        // write+destroy below usually masks the write error, so this listener
        // is not directly exercised by tests.
        const on_socket_error = () => {
          socket.destroy();
        };
        socket.on("error", on_socket_error);
        // Reject non-loopback Host before the token (DNS-rebinding defense).
        // TODO: Origin allowlist needs an Electron product decision (file:// /
        // app:// / custom protocol) — do not invent a browser Origin policy here.
        if (request_host_loopback(request) !== true) {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        if (request_token_ok(request, token) !== true) {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        if (stopping === true) {
          // Graceful-shutdown race: stop() drains in-flight RPC; do not accept
          // a new client whose handlers could put() after dispose().
          socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        wss?.handleUpgrade(request, socket, head, (client) => {
          socket.off("error", on_socket_error);
          attach_client(client, version, sessions, prompts, inflight);
        });
      });
      try {
        const port = await listen_http(http_server, host, want_port);
        boot = { port, token };
        options.on_listening?.(boot);
        emit_boot_line(options.boot_stdout, boot);
        return boot;
      } catch (error) {
        await close_wss(wss);
        await close_http(http_server);
        http_server = undefined;
        wss = undefined;
        boot = undefined;
        prompts = undefined;
        owned_agent?.close();
        owned_agent = undefined;
        throw error;
      }
    },
    stop: async () => {
      // Reject new upgrades while stopping; then close clients so no new
      // frames are enqueued, and drain in-flight handlers before dispose() —
      // a mid-I/O create/resume must not put() a bag after the store is
      // dropped (leak across restarts).
      stopping = true;
      const sockets = wss === undefined ? [] : [...wss.clients];
      await Promise.all(sockets.map((client) => close_client_with_grace(client)));
      await close_wss(wss);
      wss = undefined;
      await close_http(http_server);
      http_server = undefined;
      // Abort in-flight model calls so prompt.submit chains settle; otherwise
      // the first SIGINT/SIGTERM waits out the whole run before draining.
      prompts?.abort_all();
      while (inflight.size > 0) {
        await Promise.allSettled(inflight);
      }
      boot = undefined;
      prompts = undefined;
      owned_agent?.close();
      owned_agent = undefined;
      sessions.dispose();
    },
  };
}

async function resolve_agent(options: ServeOptions): Promise<Agent | undefined> {
  if (options.agent !== undefined) {
    return options.agent;
  }
  if (options.agent_config !== undefined) {
    return create_agent_with_plugins(options.agent_config);
  }
  return undefined;
}

/**
 * Per-connection handler chain plus a server-wide in-flight set: stop() closes
 * clients first, then drains this set so no handler runs after dispose().
 */
function attach_client(
  client: WebSocket,
  version: string,
  sessions: ServeSessionStore,
  prompts: ServePromptService | undefined,
  inflight: Set<Promise<void>>,
): void {
  // Serialize frames per connection: pipelined requests get in-order replies,
  // and the tail catch keeps any rejection from becoming an unhandled one.
  let tail: Promise<void> = Promise.resolve();
  client.on("message", (data) => {
    const chain = tail
      .then(() => handle_client_message(client, data, version, sessions, prompts))
      .catch((error: unknown) => {
        logger.warn("serve client message handling failed", error);
      });
    tail = chain;
    // Track the exact chain (not the mutable tail) so stop() drains this one.
    inflight.add(chain);
    void chain.then(() => {
      inflight.delete(chain);
    });
  });
}

async function handle_client_message(
  client: WebSocket,
  data: RawData,
  version: string,
  sessions: ServeSessionStore,
  prompts: ServePromptService | undefined,
): Promise<void> {
  const notify = (notification: ServeEventNotification): void => {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(notification));
    }
  };
  const reply = await handle_serve_rpc_message(raw_data_to_string(data), {
    version,
    sessions,
    prompts,
    notify,
  });
  if (reply !== undefined && client.readyState === client.OPEN) {
    client.send(reply);
  }
}

function raw_data_to_string(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function request_host_loopback(request: IncomingMessage): boolean {
  const raw = request.headers.host;
  if (typeof raw !== "string" || raw.length === 0) {
    return false;
  }
  try {
    const { hostname } = new URL(`http://${raw}`);
    return is_loopback_hostname(hostname);
  } catch {
    return false;
  }
}

function is_loopback_hostname(hostname: string): boolean {
  // WHATWG URL.hostname keeps brackets for IPv6 (`"[::1]"`); strip before compare.
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function request_token_ok(request: IncomingMessage, expected: string): boolean {
  const got = read_request_token(request);
  if (got === undefined) {
    return false;
  }
  return tokens_equal(got, expected);
}

function read_request_token(request: IncomingMessage): string | undefined {
  const header = request.headers["x-lich-token"];
  if (typeof header === "string" && header.length > 0) {
    return header;
  }
  if (Array.isArray(header) && typeof header[0] === "string" && header[0].length > 0) {
    return header[0];
  }
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const query = url.searchParams.get("token");
    return query !== null && query.length > 0 ? query : undefined;
  } catch {
    return undefined;
  }
}

function tokens_equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function assert_loopback_host(host: string): void {
  if (is_loopback_hostname(host)) {
    return;
  }
  throw new Error(`lich serve binds loopback only (got ${host})`);
}

function emit_boot_line(
  sink: NodeJS.WritableStream | null | undefined,
  info: ServeBootInfo,
): void {
  if (sink === null) {
    return;
  }
  const out = sink ?? process.stdout;
  out.write(`${JSON.stringify({ port: info.port, token: info.token })}\n`);
}

function listen_http(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const on_error = (error: Error) => {
      reject(error);
    };
    server.once("error", on_error);
    server.listen(port, host, () => {
      server.off("error", on_error);
      const bound = (server.address() as { port?: number } | null)?.port;
      if (bound === undefined) {
        reject(new Error("lich serve failed to resolve bound port"));
        return;
      }
      resolve(bound);
    });
  });
}

function close_client_with_grace(client: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (client.readyState === client.CLOSED) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      client.terminate();
      resolve();
    }, CLOSE_GRACE_MS);
    client.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    client.close();
  });
}

async function close_http(server: Server | undefined): Promise<void> {
  if (server === undefined) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function close_wss(wss: WebSocketServer | undefined): Promise<void> {
  if (wss === undefined) {
    return;
  }
  await new Promise<void>((resolve) => {
    wss.close(() => resolve());
  });
}
