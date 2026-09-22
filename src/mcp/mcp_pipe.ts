import { safe_json_parse } from "../util/json.js";
import type { LineChild } from "./mcp_child.js";
import type { McpPipe } from "./mcp_session.js";

interface JsonRpcMessage {
  id?: number;
  method?: string;
  error?: { message?: string };
  result?: unknown;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function parse_rpc_line(line: string): JsonRpcMessage | undefined {
  const parsed = safe_json_parse<unknown>(line);
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  return parsed as JsonRpcMessage;
}

function error_message(error: { message?: string } | undefined): string {
  const detail = error?.message;
  return typeof detail === "string" && detail.length > 0 ? detail : "mcp error";
}

function reject_all(pending: Map<number, Pending>, message: string): void {
  for (const waiter of pending.values()) {
    waiter.reject(new Error(message));
  }
  pending.clear();
}

function settle_response(pending: Map<number, Pending>, parsed: JsonRpcMessage): void {
  if (typeof parsed.id !== "number") {
    return;
  }
  const waiter = pending.get(parsed.id);
  if (waiter === undefined) {
    return;
  }
  pending.delete(parsed.id);
  if (parsed.error !== undefined) {
    waiter.reject(new Error(error_message(parsed.error)));
    return;
  }
  waiter.resolve(parsed.result);
}

function start_pump(child: LineChild, pending: Map<number, Pending>): Promise<void> {
  return (async () => {
    for (;;) {
      const line = await child.read_line();
      const failure = child.failed();
      if (failure !== undefined) {
        reject_all(pending, failure);
        return;
      }
      if (line === undefined) {
        reject_all(pending, "mcp closed the pipe");
        return;
      }
      const parsed = parse_rpc_line(line);
      if (parsed === undefined || typeof parsed.method === "string") {
        continue;
      }
      settle_response(pending, parsed);
    }
  })();
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function with_signal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  if (aborted(signal) === true) {
    return Promise.reject(new Error("cancelled"));
  }
  return new Promise<T>((resolve, reject) => {
    const on_abort = (): void => {
      reject(new Error("cancelled"));
    };
    signal.addEventListener("abort", on_abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", on_abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", on_abort);
        reject(error);
      },
    );
  });
}

export function stdio_pipe(child: LineChild): McpPipe {
  let next_id = 1;
  const pending = new Map<number, Pending>();
  let pump: Promise<void> | undefined;
  return {
    request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
      if (aborted(signal) === true) {
        return Promise.reject(new Error("cancelled"));
      }
      const id = next_id;
      next_id += 1;
      const wait = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      child.write_line(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      pump ??= start_pump(child, pending);
      return with_signal(wait, signal);
    },
    notify(method: string): void {
      child.write_line(JSON.stringify({ jsonrpc: "2.0", method }));
    },
    close(): void {
      reject_all(pending, "mcp closed the pipe");
      child.stop();
    },
  };
}
