/**
 * Loopback WebSocket JSON-RPC transport for `lich serve`.
 * Token-gated upgrade; emits one machine-readable boot JSON line.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { LICH_VERSION } from "../version.js";
import { handle_serve_rpc_message } from "./rpc.js";
import { create_serve_session_store, type ServeSessionStore } from "./sessions.js";

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
  /** Boot JSON line sink. Default `process.stdout`; `null` skips emission. */
  boot_stdout?: NodeJS.WritableStream | null;
  on_listening?: (info: ServeBootInfo) => void;
}

export interface ServeServer {
  start(): Promise<ServeBootInfo>;
  stop(): Promise<void>;
  readonly boot: ServeBootInfo | undefined;
  readonly sessions: ServeSessionStore;
}

export function create_serve_server(options: ServeOptions = {}): ServeServer {
  const host = options.host ?? DEFAULT_SERVE_HOST;
  const want_port = options.port ?? DEFAULT_SERVE_PORT;
  const token = options.token ?? randomBytes(TOKEN_BYTES).toString("hex");
  const version = options.version ?? LICH_VERSION;
  const session_dir = options.session_dir ?? path.join(process.cwd(), ".lich", "sessions");
  const sessions = create_serve_session_store(session_dir);
  assert_loopback_host(host);

  let http_server: Server | undefined;
  let wss: WebSocketServer | undefined;
  let boot: ServeBootInfo | undefined;

  return {
    get boot() {
      return boot;
    },
    get sessions() {
      return sessions;
    },
    start: async () => {
      if (http_server !== undefined) {
        throw new Error("lich serve already started");
      }
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
        wss?.handleUpgrade(request, socket, head, (client) => {
          socket.off("error", on_socket_error);
          attach_client(client, version, sessions);
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
        throw error;
      }
    },
    stop: async () => {
      const sockets = wss === undefined ? [] : [...wss.clients];
      await Promise.all(sockets.map((client) => close_client_with_grace(client)));
      await close_wss(wss);
      wss = undefined;
      await close_http(http_server);
      http_server = undefined;
      boot = undefined;
    },
  };
}

function attach_client(client: WebSocket, version: string, sessions: ServeSessionStore): void {
  client.on("message", (data) => {
    void handle_client_message(client, data, version, sessions);
  });
}

async function handle_client_message(
  client: WebSocket,
  data: RawData,
  version: string,
  sessions: ServeSessionStore,
): Promise<void> {
  const reply = await handle_serve_rpc_message(raw_data_to_string(data), { version, sessions });
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
