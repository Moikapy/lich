/**
 * JSON-RPC 2.0 request handling for `lich serve`.
 * Issue #81 implements `health` only; other locked methods return -32601.
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

const SERVE_METHOD_SET: ReadonlySet<string> = new Set(SERVE_METHODS);

export function handle_serve_rpc_message(raw: string, version: string): string | undefined {
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
  // Notifications (no id) are ignored until event fan-out needs client→server notify.
  if (body.id === undefined) {
    return undefined;
  }
  const id = as_id(body.id);
  if (id === null && body.id !== null) {
    return JSON.stringify(error_response(null, SERVE_ERROR_CODES.INVALID_REQUEST, "Invalid Request"));
  }
  return JSON.stringify(dispatch_method(id, body.method, body.params, version));
}

function dispatch_method(
  id: JsonRpcId | null,
  method: string,
  params: unknown,
  version: string,
): JsonRpcSuccess | JsonRpcError {
  if (SERVE_METHOD_SET.has(method) !== true) {
    return error_response(id, SERVE_ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
  if (method === "health") {
    if (params !== undefined && is_empty_params(params) !== true) {
      return error_response(id, SERVE_ERROR_CODES.INVALID_PARAMS, "Invalid params");
    }
    const result: HealthResult = { status: "ok", version };
    return { jsonrpc: "2.0", id: id as JsonRpcId, result };
  }
  return error_response(
    id,
    SERVE_ERROR_CODES.METHOD_NOT_FOUND,
    `Method not implemented: ${method as ServeMethod}`,
  );
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

function error_response(id: JsonRpcId | null, code: number, message: string): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
