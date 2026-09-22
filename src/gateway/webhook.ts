/**
 * Webhook adapter: the default zero-config platform. A plain node:http
 * server exposing POST /message (+ GET /health), optionally guarded by a
 * shared token via the x-lich-token header. Binds loopback by default.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { logger } from "../util/log.js";
import { format_agent_reply } from "./format.js";
import { read_platform_token } from "./token_env.js";
import type { AdapterParams, PlatformAdapter } from "./types.js";

export const DEFAULT_GATEWAY_PORT = 8089;
export const DEFAULT_GATEWAY_HOST = "127.0.0.1";
/** Reject POST bodies larger than this (G-6). */
export const MAX_WEBHOOK_BODY_BYTES = 1_000_000;

interface WebhookAdapterParams extends AdapterParams {
  port?: number;
  host?: string;
  /** Test hook: reports the resolved bound port once listening. */
  on_listening?: (port: number) => void;
}

interface IncomingPayload {
  chat_id?: unknown;
  user_id?: unknown;
  text?: unknown;
}

export function create_webhook_adapter(params: WebhookAdapterParams): PlatformAdapter {
  const port = params.port ?? read_port_env() ?? DEFAULT_GATEWAY_PORT;
  const host = params.host ?? read_host_env() ?? DEFAULT_GATEWAY_HOST;
  const token = read_platform_token(params.config, "webhook");
  let server: Server | undefined;

  return {
    name: "webhook",
    start: async () => {
      assert_bind_allowed(host, token);
      server = createServer((request, response) => {
        void dispatch_webhook(params, request, response, token);
      });
      await listen_on(server, port, host, (bound) => {
        params.on_listening?.(bound);
      });
    },
    stop: async () => {
      await close_server(server);
      server = undefined;
    },
  };
}

async function dispatch_webhook(
  params: AdapterParams,
  request: IncomingMessage,
  response: ServerResponse,
  token: string | undefined,
): Promise<void> {
  try {
    if (request.method === "GET" && request.url === "/health") {
      send_json(response, 200, { status: "ok" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/message") {
      send_json(response, 404, { error: "not found" });
      return;
    }
    if (token !== undefined && request.headers["x-lich-token"] !== token) {
      send_json(response, 401, { error: "unauthorized" });
      return;
    }
    await handle_message_post(params, request, response);
  } catch (error) {
    logger.error("gateway webhook request failed", error);
    if (response.headersSent === false) {
      send_json(response, 500, { error: "internal error" });
    }
  }
}

async function handle_message_post(
  params: AdapterParams,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (content_length_exceeds(request, MAX_WEBHOOK_BODY_BYTES) === true) {
    request.resume();
    send_json(response, 413, { error: "payload too large" });
    return;
  }
  const body = await read_body(request, MAX_WEBHOOK_BODY_BYTES);
  if (body === undefined) {
    send_json(response, 413, { error: "payload too large" });
    return;
  }
  const payload = parse_payload(body);
  const text = payload.text;
  if (text === undefined) {
    send_json(response, 400, { error: "text is required" });
    return;
  }
  // G-5: callers must not choose another platform's conversation key.
  const platform = "webhook";
  const chat_id = payload.chat_id ?? "default";
  const user_id = payload.user_id ?? "anonymous";
  const reply = await params.handle_message(platform, String(chat_id), String(user_id), String(text));
  respond_json_text(response, 200, format_agent_reply(reply ?? "", undefined, "webhook"));
}

function content_length_exceeds(request: IncomingMessage, max_bytes: number): boolean {
  const raw = request.headers["content-length"];
  if (raw === undefined) {
    return false;
  }
  const length = Number(raw);
  return Number.isFinite(length) === true && length > max_bytes;
}

/** Reads the request body; returns undefined when the stream exceeds max_bytes. */
function read_body(request: IncomingMessage, max_bytes: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    let too_large = false;
    request.on("data", (chunk: Buffer) => {
      if (too_large === true) {
        return;
      }
      size += chunk.length;
      if (size > max_bytes) {
        too_large = true;
        body = "";
        return;
      }
      body += chunk.toString("utf8");
    });
    request.on("end", () => resolve(too_large === true ? undefined : body));
    request.on("error", reject);
  });
}

function parse_payload(body: string): IncomingPayload {
  if (body.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    return parsed as IncomingPayload;
  } catch {
    return {};
  }
}

function send_json(response: ServerResponse, status: number, payload: Record<string, unknown>): void {
  respond_json_text(response, status, JSON.stringify(payload));
}

function respond_json_text(response: ServerResponse, status: number, json_text: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(json_text);
}

function listen_on(
  server: Server,
  port: number,
  host: string,
  on_listening: (port: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const bound = (server.address() as { port?: number } | null)?.port ?? port;
      logger.info(`gateway webhook listening on ${host}:${bound}`);
      on_listening(bound);
      resolve();
    });
  });
}

async function close_server(server: Server | undefined): Promise<void> {
  if (server === undefined) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

/** Loopback binds are always fine; non-loopback requires an auth token. */
export function assert_bind_allowed(host: string, token: string | undefined): void {
  if (is_loopback_host(host) === true) {
    return;
  }
  if (token === undefined || token.length === 0) {
    throw new Error(
      `gateway webhook refuses non-loopback bind (${host}) without a token — set LICH_GATEWAY_TOKEN or bind 127.0.0.1`,
    );
  }
  logger.warn(
    `gateway webhook binding ${host} with token auth — this exposes the agent beyond loopback; keep the token secret`,
  );
}

export function is_loopback_host(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function read_port_env(): number | undefined {
  const raw = process.env.LICH_GATEWAY_PORT;
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

function read_host_env(): string | undefined {
  const raw = process.env.LICH_GATEWAY_HOST;
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  return raw.trim();
}
