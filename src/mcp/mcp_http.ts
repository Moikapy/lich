/** JSON-RPC POST to a loopback MCP url. Redirects are errors. No secret headers. */
import type { McpPipe } from "./mcp_session.js";

interface RpcBody {
  error?: { message?: string };
  result?: unknown;
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function post_rpc(
  url: string,
  fetch_fn: typeof fetch,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  if (aborted(signal) === true) {
    throw new Error("cancelled");
  }
  const response = await fetch_fn(url, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const parsed = (await response.json()) as RpcBody;
  if (parsed.error !== undefined) {
    const detail = parsed.error.message;
    throw new Error(typeof detail === "string" && detail.length > 0 ? detail : "mcp error");
  }
  return parsed.result;
}

export function http_pipe(url: string, fetch_fn: typeof fetch): McpPipe {
  let next_id = 1;
  return {
    request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
      const id = next_id;
      next_id += 1;
      return post_rpc(url, fetch_fn, { jsonrpc: "2.0", id, method, params }, signal);
    },
    notify(method: string): void {
      void fetch_fn(url, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method }),
      }).catch(() => undefined);
    },
    close(): void {
      return undefined;
    },
  };
}
