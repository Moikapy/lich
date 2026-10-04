/**
 * Renderer-facing gateway client — JSON-RPC request + connection subscribe.
 * Talks only through the preload bridge (no Agent, no Node).
 */

export interface HealthResult {
  status: "ok";
  version: string;
}

export interface ConnectionInfo {
  status: "connecting" | "connected" | "error" | "stopped";
  port?: number;
  error?: string;
}

export function get_connection_info(): Promise<ConnectionInfo> {
  const api = window.ossuary;
  if (api === undefined) {
    return Promise.resolve({ status: "error", error: "preload bridge missing" });
  }
  return api.getConnectionInfo();
}

export function on_connection(handler: (info: ConnectionInfo) => void): () => void {
  const api = window.ossuary;
  if (api === undefined) {
    handler({ status: "error", error: "preload bridge missing" });
    return () => undefined;
  }
  return api.onConnection(handler);
}

export async function request_gateway(
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const api = window.ossuary;
  if (api === undefined) {
    throw new Error("preload bridge missing");
  }
  return api.requestGateway(method, params);
}

export async function fetch_health(): Promise<HealthResult> {
  const result = await request_gateway("health", {});
  if (
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    (result as { status?: unknown }).status !== "ok" ||
    typeof (result as { version?: unknown }).version !== "string"
  ) {
    throw new Error("unexpected health result");
  }
  return result as HealthResult;
}

export function subscribe_notifications(
  handler: (method: string, params: unknown) => void,
): () => void {
  const api = window.ossuary;
  if (api === undefined) {
    return () => undefined;
  }
  return api.onNotification(handler);
}
