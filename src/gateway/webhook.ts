/**
 * Webhook adapter: the default zero-config platform. A plain node:http
 * server exposing POST /message (+ GET /health), optionally guarded by a
 * shared token via the x-lich-token header.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { logger } from "../util/log.js";
import { format_agent_reply } from "./format.js";
import { read_platform_token } from "./token_env.js";
import type { AdapterParams, PlatformAdapter } from "./types.js";

export const DEFAULT_GATEWAY_PORT = 8089;

interface WebhookAdapterParams extends AdapterParams {
  port?: number;
  /** Test hook: reports the resolved bound port once listening. */
  on_listening?: (port: number) => void;
}

interface IncomingPayload {
  platform?: unknown;
  chat_id?: unknown;
  user_id?: unknown;
  text?: unknown;
}

export function create_webhook_adapter(params: WebhookAdapterParams): PlatformAdapter {
  const port = params.port ?? read_port_env() ?? DEFAULT_GATEWAY_PORT;
  const token = read_platform_token(params.config, "webhook");
  let server: Server | undefined;

  return {
    name: "webhook",
    start: async () => {
      server = createServer((request, response) => {
        void dispatch_webhook(params, request, response, token);
      });
      await listen_on(server, port, (bound) => {
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
  const body = await read_body(request);
  const payload = parse_payload(body);
  const text = payload.text;
  if (text === undefined) {
    send_json(response, 400, { error: "text is required" });
    return;
  }
  const platform = payload.platform ?? "webhook";
  const chat_id = payload.chat_id ?? "default";
  const user_id = payload.user_id ?? "anonymous";
  const reply = await params.handle_message(String(platform), String(chat_id), String(user_id), String(text));
  respond_json_text(response, 200, format_agent_reply(reply ?? "", undefined, "webhook"));
}

function read_body(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => resolve(body));
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

function listen_on(server: Server, port: number, on_listening: (port: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      const bound = (server.address() as { port?: number } | null)?.port ?? port;
      logger.info(`gateway webhook listening on :${bound}`);
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

function read_port_env(): number | undefined {
  const raw = process.env.LICH_GATEWAY_PORT;
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}