/**
 * Loopback WebSocket JSON-RPC transport for `lich serve`.
 * Token-gated upgrade; emits one machine-readable boot JSON line.
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { handle_serve_rpc_message } from "./rpc.js";

export const DEFAULT_SERVE_HOST = "127.0.0.1";
export const DEFAULT_SERVE_PORT = 0;
const TOKEN_BYTES = 24;

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
  /** Reported by `health`; defaults to package.json version. */
  version?: string;
  /** Boot JSON line sink. Default `process.stdout`; `null` skips emission. */
  boot_stdout?: NodeJS.WritableStream | null;
  on_listening?: (info: ServeBootInfo) => void;
}

export interface ServeServer {
  start(): Promise<ServeBootInfo>;
  stop(): Promise<void>;
  readonly boot: ServeBootInfo | undefined;
}

export function create_serve_server(options: ServeOptions = {}): ServeServer {
  const host = options.host ?? DEFAULT_SERVE_HOST;
  const want_port = options.port ?? DEFAULT_SERVE_PORT;
  const token = options.token ?? randomBytes(TOKEN_BYTES).toString("hex");
  const version = options.version ?? read_package_version();
  assert_loopback_host(host);

  let http_server: Server | undefined;
  let wss: WebSocketServer | undefined;
  let boot: ServeBootInfo | undefined;

  return {
    get boot() {
      return boot;
    },
    start: async () => {
      if (http_server !== undefined) {
        throw new Error("lich serve already started");
      }
      http_server = createServer((_req, res) => {
        res.statusCode = 404;
        res.end();
      });
      wss = new WebSocketServer({ noServer: true });
      http_server.on("upgrade", (request, socket, head) => {
        if (request_token_ok(request, token) !== true) {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        wss?.handleUpgrade(request, socket, head, (client) => {
          attach_client(client, version);
        });
      });
      const port = await listen_http(http_server, host, want_port);
      boot = { port, token };
      options.on_listening?.(boot);
      emit_boot_line(options.boot_stdout, boot);
      return boot;
    },
    stop: async () => {
      const sockets = wss === undefined ? [] : [...wss.clients];
      for (const client of sockets) {
        client.close();
      }
      await close_wss(wss);
      wss = undefined;
      await close_http(http_server);
      http_server = undefined;
      boot = undefined;
    },
  };
}

function attach_client(client: WebSocket, version: string): void {
  client.on("message", (data) => {
    const reply = handle_serve_rpc_message(raw_data_to_string(data), version);
    if (reply !== undefined && client.readyState === client.OPEN) {
      client.send(reply);
    }
  });
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

function read_package_version(): string {
  const pkg_path = fileURLToPath(new URL("../../package.json", import.meta.url));
  const pkg = JSON.parse(readFileSync(pkg_path, "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error("package.json is missing version");
  }
  return pkg.version;
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
  const normalized = host.trim().toLowerCase();
  if (normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost") {
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
    server.once("error", reject);
    server.listen(port, host, () => {
      const bound = (server.address() as { port?: number } | null)?.port;
      if (bound === undefined) {
        reject(new Error("lich serve failed to resolve bound port"));
        return;
      }
      resolve(bound);
    });
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
