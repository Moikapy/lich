import { safe_json_parse } from "../util/json.js";
import type { LineChild } from "./mcp_child.js";
import type { McpPipe } from "./mcp_session.js";

const SKIP_LIMIT = 32;

interface JsonRpcMessage {
  id?: number;
  error?: { message?: string };
  result?: unknown;
}

function parse_rpc_line(line: string): JsonRpcMessage | undefined {
  const parsed = safe_json_parse<unknown>(line);
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  return parsed as JsonRpcMessage;
}

async function read_id(child: LineChild, id: number): Promise<unknown> {
  for (let skipped = 0; skipped < SKIP_LIMIT; skipped += 1) {
    const line = await child.read_line();
    const failure = child.failed();
    if (failure !== undefined) {
      throw new Error(failure);
    }
    if (line === undefined) {
      throw new Error("mcp closed the pipe");
    }
    const parsed = parse_rpc_line(line);
    if (parsed === undefined || parsed.id !== id) {
      continue;
    }
    if (parsed.error !== undefined) {
      const detail = parsed.error.message;
      throw new Error(typeof detail === "string" && detail.length > 0 ? detail : "mcp error");
    }
    return parsed.result;
  }
  throw new Error("mcp sent no matching response");
}

export function stdio_pipe(child: LineChild): McpPipe {
  let next_id = 1;
  return {
    request(method: string, params: unknown): Promise<unknown> {
      const id = next_id;
      next_id += 1;
      child.write_line(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      return read_id(child, id);
    },
    notify(method: string): void {
      child.write_line(JSON.stringify({ jsonrpc: "2.0", method }));
    },
    close(): void {
      child.stop();
    },
  };
}
