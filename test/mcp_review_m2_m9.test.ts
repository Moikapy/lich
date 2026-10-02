/**
 * Review M-2 / M-3 / M-8 / M-9 coverage for the MCP client.
 */
import { describe, expect, it } from "vitest";
import { create_line_queue } from "../src/mcp/mcp_lines.js";
import type { LineChild } from "../src/mcp/mcp_child.js";
import { stdio_pipe } from "../src/mcp/mcp_pipe.js";
import { MCP_NAME_MAX, MCP_SCHEMA_JSON_MAX, parse_tools } from "../src/mcp/mcp_result.js";
import { content_text } from "../src/mcp/mcp_content.js";

function scripted_child(replies: Map<number, unknown>): LineChild {
  const queue = create_line_queue();
  const inbox: Array<{ id: number }> = [];
  return {
    write_line(line: string): void {
      const msg = JSON.parse(line) as { id?: number; method?: string };
      if (typeof msg.id !== "number") {
        return;
      }
      inbox.push({ id: msg.id });
      const result = replies.get(msg.id) ?? { ok: true };
      // Delay id 1 so a concurrent id 2 can be written first; pump must not FIFO-desync.
      const delay = msg.id === 1 ? 20 : 0;
      setTimeout(() => {
        queue.push(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      }, delay);
    },
    read_line: () => queue.read(),
    stop(): void {
      queue.close();
    },
    failed: () => undefined,
  };
}

describe("mcp_pipe id map (M-2)", () => {
  it("resolves out-of-order responses by id", async () => {
    const pipe = stdio_pipe(scripted_child(new Map([[1, { a: 1 }], [2, { b: 2 }]])));
    const first = pipe.request("slow", {});
    const second = pipe.request("fast", {});
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual({ a: 1 });
    expect(b).toEqual({ b: 2 });
    pipe.close();
  });

  it("honors AbortSignal on an in-flight request (M-3)", async () => {
    const queue = create_line_queue();
    const child: LineChild = {
      write_line(): void {
        return undefined;
      },
      read_line: () => queue.read(),
      stop(): void {
        queue.close();
      },
      failed: () => undefined,
    };
    const pipe = stdio_pipe(child);
    const controller = new AbortController();
    const pending = pipe.request("hang", {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    pipe.close();
  });

  it("rejects later requests after the child closes the pipe", async () => {
    let reads = 0;
    const child: LineChild = {
      write_line(): void {
        return undefined;
      },
      read_line: async () => {
        reads += 1;
        return undefined;
      },
      stop(): void {
        return undefined;
      },
      failed: () => undefined,
    };
    const pipe = stdio_pipe(child);
    await expect(pipe.request("first", {})).rejects.toThrow(/mcp closed the pipe/);
    await expect(pipe.request("second", {})).rejects.toThrow(/mcp closed the pipe/);
    expect(reads).toBe(1);
    pipe.close();
  });
});

describe("mcp metadata bounds (M-9)", () => {
  it("drops oversized tool names and clamps descriptions", () => {
    const long_name = "x".repeat(MCP_NAME_MAX + 1);
    const long_desc = "d".repeat(5000);
    const tools = parse_tools({
      tools: [
        { name: long_name, description: "nope", inputSchema: { type: "object" } },
        { name: "ok", description: long_desc, inputSchema: { type: "object" } },
      ],
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("ok");
    expect(tools[0]?.description.length).toBe(2000);
  });

  it("drops an oversized inputSchema and non-string required entries", () => {
    const huge = {
      type: "object",
      properties: { blob: { type: "string", description: "x".repeat(MCP_SCHEMA_JSON_MAX) } },
    };
    const tools = parse_tools({
      tools: [
        { name: "big", description: "oversized", inputSchema: huge },
        {
          name: "shaped",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path", 1, null],
            additionalProperties: false,
          },
        },
        null,
        { name: "", description: "blank" },
      ],
    });
    expect(tools.map((tool) => tool.name)).toEqual(["big", "shaped"]);
    expect(tools[0]?.parameters).toEqual({ type: "object" });
    expect(tools[1]?.parameters).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    });
  });

  it("rejects a tools/list body that is not an object with a tools array", () => {
    expect(() => parse_tools(null)).toThrow(/mcp tools\/list rejected/);
    expect(() => parse_tools({ tools: {} })).toThrow(/mcp tools\/list rejected/);
  });

  it("omits images and names an empty tool error", () => {
    expect(
      content_text({
        content: [{ type: "image", data: "abc" }, { type: "text", text: "ok" }, "skip", { type: "resource" }],
      }),
    ).toBe("[image omitted]\nok");
    expect(() => content_text({ isError: true, content: [] })).toThrow("mcp tool failed");
    expect(content_text("nope")).toBe("");
  });

  it("delivers a queued line to a waiting reader and ends readers on close", async () => {
    const queue = create_line_queue();
    const pending = queue.read();
    queue.push("line-1");
    await expect(pending).resolves.toBe("line-1");
    const waiting = queue.read();
    queue.close();
    await expect(waiting).resolves.toBeUndefined();
    await expect(queue.read()).resolves.toBeUndefined();
  });

  it("clamps tool error text from content_text", () => {
    const huge = "e".repeat(8000);
    expect(() => content_text({ isError: true, content: [{ type: "text", text: huge }] })).toThrow();
    try {
      content_text({ isError: true, content: [{ type: "text", text: huge }] });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message.length).toBeLessThanOrEqual(4000);
    }
  });
});
