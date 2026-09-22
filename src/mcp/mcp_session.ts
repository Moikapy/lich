/**
 * JSON-RPC MCP session: initialize, tools/list, tools/call.
 * Does not require a particular serverInfo.name.
 */
import { assert_handshake, init_params } from "./mcp_handshake.js";
import { content_text } from "./mcp_content.js";
import { parse_tools, type ListedTool } from "./mcp_result.js";

export type { ListedTool } from "./mcp_result.js";

export interface McpPipe {
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  notify(method: string): void;
  close(): void;
}

export class McpSession {
  private ready_done = false;
  private closed = false;

  constructor(private readonly pipe: McpPipe) {}

  close(): void {
    if (this.closed === true) {
      return;
    }
    this.closed = true;
    this.pipe.close();
  }

  async list_tools(signal?: AbortSignal): Promise<ListedTool[]> {
    await this.ensure_ready(signal);
    return parse_tools(await this.pipe.request("tools/list", {}, signal));
  }

  async call_tool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    await this.ensure_ready(signal);
    return content_text(await this.pipe.request("tools/call", { name, arguments: args }, signal));
  }

  private async ensure_ready(signal?: AbortSignal): Promise<void> {
    if (this.ready_done === true) {
      return;
    }
    try {
      assert_handshake(await this.pipe.request("initialize", init_params(), signal));
      this.pipe.notify("notifications/initialized");
      this.ready_done = true;
    } catch (error) {
      this.close();
      throw error;
    }
  }
}
