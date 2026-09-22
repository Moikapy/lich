/**
 * node:http surface with the webhook shape: POST /message → {reply, usage}.
 * Binds loopback. The CLI webhook binds 0.0.0.0; this example does not.
 * Auth is required: callers must send x-lich-token matching `token`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Orchestrator } from "./orchestrator.js";
import { webhook_body } from "./reply.js";

/** ~1 MB — enough for a combat prompt, small enough to reject abuse. */
export const DEFAULT_MAX_BODY_BYTES = 1_000_000;

export interface ServerParams {
  orchestrator: Orchestrator;
  port?: number;
  /** Required shared secret checked via x-lich-token. */
  token: string;
  on_listening?: (port: number) => void;
  max_body_bytes?: number;
}

export interface PersonaServer {
  port: number;
  stop(): Promise<void>;
}

interface IncomingPayload {
  platform?: unknown;
  chat_id?: unknown;
  text?: unknown;
}

export async function start_persona_server(params: ServerParams): Promise<PersonaServer> {
  if (params.token.trim().length === 0) {
    throw new Error("persona server requires a non-empty token — set LICH_GATEWAY_TOKEN");
  }
  const max_body_bytes = params.max_body_bytes ?? DEFAULT_MAX_BODY_BYTES;
  const server = createServer((request, response) => {
    void dispatch(params, request, response, max_body_bytes);
  });
  const port = await listen_on(server, params.port ?? 0, params.on_listening);
  return { port, stop: () => close_server(server) };
}

async function dispatch(
  params: ServerParams,
  request: IncomingMessage,
  response: ServerResponse,
  max_body_bytes: number,
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
    if (host_is_loopback(request.headers.host) === false) {
      send_json(response, 400, { error: "invalid host" });
      return;
    }
    if (request.headers["x-lich-token"] !== params.token) {
      send_json(response, 401, { error: "unauthorized" });
      return;
    }
    if (content_type_is_json(request.headers["content-type"]) === false) {
      send_json(response, 415, { error: "content-type must be application/json" });
      return;
    }
    await handle_post(params.orchestrator, request, response, max_body_bytes);
  } catch (error) {
    if (response.headersSent === false) {
      if (error instanceof BodyTooLargeError) {
        send_json(response, 413, { error: "payload too large" });
        return;
      }
      send_json(response, 500, { error: "internal error" });
    }
  }
}

async function handle_post(
  orchestrator: Orchestrator,
  request: IncomingMessage,
  response: ServerResponse,
  max_body_bytes: number,
): Promise<void> {
  const payload = parse_payload(await read_body(request, max_body_bytes));
  if (typeof payload.text !== "string" || payload.text.length === 0) {
    send_json(response, 400, { error: "text is required" });
    return;
  }
  const platform = typeof payload.platform === "string" && payload.platform.length > 0 ? payload.platform : "webhook";
  const chat_id = typeof payload.chat_id === "string" && payload.chat_id.length > 0 ? payload.chat_id : "";
  const result = await orchestrator.handle(platform, chat_id, payload.text);
  respond_text(response, 200, webhook_body(result.reply, result.usage));
}

function send_json(response: ServerResponse, status: number, payload: Record<string, unknown>): void {
  respond_text(response, status, JSON.stringify(payload));
}

function respond_text(response: ServerResponse, status: number, json_text: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(json_text);
}

class BodyTooLargeError extends Error {
  constructor() {
    super("payload too large");
    this.name = "BodyTooLargeError";
  }
}

function read_body(request: IncomingMessage, max_body_bytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    request.on("data", (chunk: Buffer) => {
      if (overflow === true) {
        return;
      }
      size += chunk.length;
      if (size > max_body_bytes) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (overflow === true) {
        reject(new BodyTooLargeError());
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
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

/** Accept only loopback Host values (with optional port). Blocks DNS-rebinding Host spoofing. */
export function host_is_loopback(host_header: string | undefined): boolean {
  if (host_header === undefined || host_header.trim().length === 0) {
    return false;
  }
  const raw = host_header.trim().toLowerCase();
  let hostname: string;
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end === -1) {
      return false;
    }
    hostname = raw.slice(1, end);
  } else {
    const colon = raw.lastIndexOf(":");
    if (colon !== -1 && /^\d+$/.test(raw.slice(colon + 1))) {
      hostname = raw.slice(0, colon);
    } else {
      hostname = raw;
    }
  }
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function content_type_is_json(header: string | string[] | undefined): boolean {
  const value = Array.isArray(header) === true ? header[0] : header;
  if (value === undefined) {
    return false;
  }
  const media = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return media === "application/json";
}

function listen_on(server: Server, port: number, on_listening?: (port: number) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const bound = (server.address() as { port?: number } | null)?.port ?? port;
      on_listening?.(bound);
      resolve(bound);
    });
  });
}

function close_server(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
