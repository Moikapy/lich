/**
 * node:http surface with the webhook shape: POST /message → {reply, usage}.
 * Binds loopback. The CLI webhook binds 0.0.0.0; this example does not.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Orchestrator } from "./orchestrator.js";
import { webhook_body } from "./reply.js";

export interface ServerParams {
  orchestrator: Orchestrator;
  port?: number;
  token?: string;
  on_listening?: (port: number) => void;
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
  const server = createServer((request, response) => {
    void dispatch(params, request, response);
  });
  const port = await listen_on(server, params.port ?? 0, params.on_listening);
  return { port, stop: () => close_server(server) };
}

async function dispatch(params: ServerParams, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    if (request.method === "GET" && request.url === "/health") {
      send_json(response, 200, { status: "ok" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/message") {
      send_json(response, 404, { error: "not found" });
      return;
    }
    if (params.token !== undefined && request.headers["x-lich-token"] !== params.token) {
      send_json(response, 401, { error: "unauthorized" });
      return;
    }
    await handle_post(params.orchestrator, request, response);
  } catch {
    if (response.headersSent === false) {
      send_json(response, 500, { error: "internal error" });
    }
  }
}

async function handle_post(orchestrator: Orchestrator, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const payload = parse_payload(await read_body(request));
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
