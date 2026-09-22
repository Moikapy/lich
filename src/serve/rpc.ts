/**
 * JSON-RPC 2.0 request handling for `lich serve`.
 * Implements health, session.*, and prompt.* (Agent via ServePromptService).
 */
import { safe_json_parse } from "../util/json.js";
import type {
  HealthResult,
  JsonRpcError,
  JsonRpcId,
  JsonRpcSuccess,
  ServeMethod,
} from "./protocol.js";
import { SERVE_ERROR_CODES, SERVE_METHODS } from "./protocol.js";
import type { ServeEventNotify, ServePromptService } from "./prompts.js";
import type { ServeSessionStore } from "./sessions.js";

const SERVE_METHOD_SET: ReadonlySet<string> = new Set(SERVE_METHODS);

export interface ServeRpcContext {
  version: string;
  sessions: ServeSessionStore;
  /** Present when the server was started with an Agent / agent_config. */
  prompts?: ServePromptService;
  /** Server→client event fan-out for the active WebSocket (or test sink). */
  notify?: ServeEventNotify;
}

export async function handle_serve_rpc_message(
  raw: string,
  context: ServeRpcContext,
): Promise<string | undefined> {
  const parsed = safe_json_parse<unknown>(raw);
  if (parsed === undefined) {
    return JSON.stringify(error_response(null, SERVE_ERROR_CODES.PARSE_ERROR, "Parse error"));
  }
  if (Array.isArray(parsed)) {
    return JSON.stringify(
      error_response(null, SERVE_ERROR_CODES.INVALID_REQUEST, "Batch requests are not supported"),
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    return JSON.stringify(error_response(null, SERVE_ERROR_CODES.INVALID_REQUEST, "Invalid Request"));
  }
  const body = parsed as Record<string, unknown>;
  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return JSON.stringify(
      error_response(as_id(body.id), SERVE_ERROR_CODES.INVALID_REQUEST, "Invalid Request"),
    );
  }
  // Client→server notifications (no id) are ignored.
  if (body.id === undefined) {
    return undefined;
  }
  const id = as_id(body.id);
  if (id === null && body.id !== null) {
    return JSON.stringify(error_response(null, SERVE_ERROR_CODES.INVALID_REQUEST, "Invalid Request"));
  }
  return JSON.stringify(await dispatch_method(id, body.method, body.params, context));
}

async function dispatch_method(
  id: JsonRpcId | null,
  method: string,
  params: unknown,
  context: ServeRpcContext,
): Promise<JsonRpcSuccess | JsonRpcError> {
  if (SERVE_METHOD_SET.has(method) !== true) {
    return error_response(id, SERVE_ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
  if (method === "health") {
    if (params !== undefined && is_empty_params(params) !== true) {
      return error_response(id, SERVE_ERROR_CODES.INVALID_PARAMS, "Invalid params");
    }
    const result: HealthResult = { status: "ok", version: context.version };
    return { jsonrpc: "2.0", id: id as JsonRpcId, result };
  }
  if (method === "session.create") {
    return dispatch_session_create(id, params, context.sessions);
  }
  if (method === "session.clear") {
    return dispatch_session_clear(id, params, context.sessions);
  }
  if (method === "session.list") {
    return dispatch_session_list(id, params, context.sessions);
  }
  if (method === "session.resume") {
    return dispatch_session_resume(id, params, context.sessions);
  }
  if (method === "prompt.submit") {
    return dispatch_prompt_submit(id, params, context);
  }
  if (method === "prompt.abort") {
    return dispatch_prompt_abort(id, params, context);
  }
  return error_response(
    id,
    SERVE_ERROR_CODES.METHOD_NOT_FOUND,
    `Method not implemented: ${method as ServeMethod}`,
  );
}

async function dispatch_session_create(
  id: JsonRpcId | null,
  params: unknown,
  sessions: ServeSessionStore,
): Promise<JsonRpcSuccess | JsonRpcError> {
  const parsed = parse_session_create(params);
  if (parsed === undefined) {
    return error_response(id, SERVE_ERROR_CODES.INVALID_PARAMS, "Invalid params");
  }
  try {
    const result = await sessions.create(parsed);
    return { jsonrpc: "2.0", id: id as JsonRpcId, result };
  } catch (error) {
    return error_response(id, SERVE_ERROR_CODES.APPLICATION_ERROR, error_message(error));
  }
}

function dispatch_session_clear(
  id: JsonRpcId | null,
  params: unknown,
  sessions: ServeSessionStore,
): JsonRpcSuccess | JsonRpcError {
  const session_id = read_string_field(params, "session_id");
  if (session_id === undefined) {
    return error_response(id, SERVE_ERROR_CODES.INVALID_PARAMS, "Invalid params");
  }
  try {
    const result = sessions.clear({ session_id });
    return { jsonrpc: "2.0", id: id as JsonRpcId, result };
  } catch (error) {
    return error_response(id, SERVE_ERROR_CODES.APPLICATION_ERROR, error_message(error));
  }
}

async function dispatch_session_list(
  id: JsonRpcId | null,
  params: unknown,
  sessions: ServeSessionStore,
): Promise<JsonRpcSuccess | JsonRpcError> {
  if (params !== undefined && is_empty_params(params) !== true) {
    return error_response(id, SERVE_ERROR_CODES.INVALID_PARAMS, "Invalid params");
  }
  try {
    const result = await sessions.list();
    return { jsonrpc: "2.0", id: id as JsonRpcId, result };
  } catch (error) {
    return error_response(id, SERVE_ERROR_CODES.APPLICATION_ERROR, error_message(error));
  }
}

async function dispatch_session_resume(
  id: JsonRpcId | null,
  params: unknown,
  sessions: ServeSessionStore,
): Promise<JsonRpcSuccess | JsonRpcError> {
  const resume_id = read_string_field(params, "id");
  if (resume_id === undefined) {
    return error_response(id, SERVE_ERROR_CODES.INVALID_PARAMS, "Invalid params");
  }
  try {
    const result = await sessions.resume({ id: resume_id });
    return { jsonrpc: "2.0", id: id as JsonRpcId, result };
  } catch (error) {
    return error_response(id, SERVE_ERROR_CODES.APPLICATION_ERROR, error_message(error));
  }
}

async function dispatch_prompt_submit(
  id: JsonRpcId | null,
  params: unknown,
  context: ServeRpcContext,
): Promise<JsonRpcSuccess | JsonRpcError> {
  if (context.prompts === undefined) {
    return error_response(id, SERVE_ERROR_CODES.APPLICATION_ERROR, "agent not configured");
  }
  const parsed = parse_prompt_submit(params);
  if (parsed === undefined) {
    return error_response(id, SERVE_ERROR_CODES.INVALID_PARAMS, "Invalid params");
  }
  const notify = context.notify ?? (() => undefined);
  try {
    const result = await context.prompts.submit(parsed, notify);
    return { jsonrpc: "2.0", id: id as JsonRpcId, result };
  } catch (error) {
    return error_response(id, SERVE_ERROR_CODES.APPLICATION_ERROR, error_message(error));
  }
}

function dispatch_prompt_abort(
  id: JsonRpcId | null,
  params: unknown,
  context: ServeRpcContext,
): JsonRpcSuccess | JsonRpcError {
  if (context.prompts === undefined) {
    return error_response(id, SERVE_ERROR_CODES.APPLICATION_ERROR, "agent not configured");
  }
  const session_id = read_string_field(params, "session_id");
  if (session_id === undefined) {
    return error_response(id, SERVE_ERROR_CODES.INVALID_PARAMS, "Invalid params");
  }
  try {
    const result = context.prompts.abort({ session_id });
    return { jsonrpc: "2.0", id: id as JsonRpcId, result };
  } catch (error) {
    return error_response(id, SERVE_ERROR_CODES.APPLICATION_ERROR, error_message(error));
  }
}

function parse_session_create(
  params: unknown,
): { source: string; label?: string } | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return undefined;
  }
  const body = params as Record<string, unknown>;
  if (typeof body.source !== "string" || body.source.length === 0) {
    return undefined;
  }
  if (body.label === undefined) {
    return { source: body.source };
  }
  if (typeof body.label !== "string") {
    return undefined;
  }
  return { source: body.source, label: body.label };
}

function parse_prompt_submit(
  params: unknown,
): { session_id: string; text: string } | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return undefined;
  }
  const body = params as Record<string, unknown>;
  if (typeof body.session_id !== "string" || body.session_id.length === 0) {
    return undefined;
  }
  if (typeof body.text !== "string") {
    return undefined;
  }
  return { session_id: body.session_id, text: body.text };
}

function read_string_field(params: unknown, key: string): string | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return undefined;
  }
  const value = (params as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function is_empty_params(params: unknown): boolean {
  if (params === null || params === undefined) {
    return true;
  }
  if (typeof params !== "object" || Array.isArray(params)) {
    return false;
  }
  return Object.keys(params as object).length === 0;
}

function as_id(value: unknown): JsonRpcId | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  return null;
}

function error_message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function error_response(id: JsonRpcId | null, code: number, message: string): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
