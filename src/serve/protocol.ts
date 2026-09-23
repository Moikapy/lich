/**
 * Shared JSON-RPC contract for `lich serve` (desktop/TUI-grade).
 * Types only — no listening server here.
 */
import type { AgentEvent } from "../agent/events.js";
import type { LoopOutcome } from "../agent/loop.js";
import type { Usage } from "../providers/types.js";

/** Locked method names for the serve surface. */
export const SERVE_METHODS = [
  "health",
  "session.create",
  "session.list",
  "session.clear",
  "prompt.submit",
  "prompt.abort",
] as const;

export type ServeMethod = (typeof SERVE_METHODS)[number];

/** Locked notification name for AgentEvent fan-out. */
export const SERVE_NOTIFICATION_EVENT = "event" as const;

export type ServeNotificationMethod = typeof SERVE_NOTIFICATION_EVENT;

export type JsonRpcId = string | number;

export interface JsonRpcRequest<M extends string = string, P = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: M;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: R;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: JsonRpcErrorBody;
}

export interface JsonRpcNotification<M extends string = string, P = unknown> {
  jsonrpc: "2.0";
  method: M;
  params: P;
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcError;

/** Params / results per locked method. */

export type HealthParams = Record<string, never>;

export interface HealthResult {
  status: "ok";
  version: string;
}

export interface SessionCreateParams {
  /** Optional display label for the new session file. */
  label?: string;
  /** Origin tag (e.g. `ossuary`, `tui`) — stored with the session. */
  source: string;
}

export interface SessionCreateResult {
  session_id: string;
}

export type SessionListParams = Record<string, never>;

export interface SessionListEntry {
  id: string;
  mtime_ms: number;
}

export interface SessionListResult {
  sessions: SessionListEntry[];
}

export interface SessionClearParams {
  session_id: string;
}

export interface SessionClearResult {
  session_id: string;
}

export interface PromptSubmitParams {
  session_id: string;
  text: string;
}

export interface PromptSubmitResult {
  session_id: string;
  reply: string | undefined;
  usage: Usage;
  session_path: string | undefined;
  turns_used: number;
  stopped_reason: LoopOutcome["stopped_reason"];
}

export interface PromptAbortParams {
  session_id: string;
}

export interface PromptAbortResult {
  session_id: string;
  aborted: boolean;
}

/** Notification payload: 1:1 AgentEvent plus session routing. */
export interface ServeEventParams {
  session_id: string;
  event: AgentEvent;
}

export type ServeEventNotification = JsonRpcNotification<
  ServeNotificationMethod,
  ServeEventParams
>;

/** Map method name → params / result for typed clients and handlers. */
export interface ServeMethodMap {
  health: { params: HealthParams; result: HealthResult };
  "session.create": { params: SessionCreateParams; result: SessionCreateResult };
  "session.list": { params: SessionListParams; result: SessionListResult };
  "session.clear": { params: SessionClearParams; result: SessionClearResult };
  "prompt.submit": { params: PromptSubmitParams; result: PromptSubmitResult };
  "prompt.abort": { params: PromptAbortParams; result: PromptAbortResult };
}

/** Serve requests require params (unlike bare JSON-RPC, which may omit them). */
export type ServeRequest<M extends ServeMethod = ServeMethod> = JsonRpcRequest<
  M,
  ServeMethodMap[M]["params"]
> & { params: ServeMethodMap[M]["params"] };

export type ServeSuccess<M extends ServeMethod = ServeMethod> = JsonRpcSuccess<
  ServeMethodMap[M]["result"]
>;
