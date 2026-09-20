import { create_line_queue, type LineQueue } from "./mcp_lines.js";
import { failed_child, spawn_failure, type LineChild } from "./mcp_child.js";

async function pump_stdout(stream: ReadableStream<Uint8Array>, queue: LineQueue): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const next = await reader.read();
    if (next.done === true) {
      if (buffer.length > 0) {
        queue.push(buffer);
      }
      queue.close();
      return;
    }
    buffer += decoder.decode(next.value, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      queue.push(part);
    }
  }
}

async function drain_stderr(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  while ((await reader.read()).done === false) {
    continue;
  }
}

export function bun_line_child(command: string, args: readonly string[], env?: Record<string, string>): LineChild {
  const queue = create_line_queue();
  try {
    const options = { stdin: "pipe" as const, stdout: "pipe" as const, stderr: "pipe" as const };
    const child = env === undefined ? Bun.spawn([command, ...args], options) : Bun.spawn([command, ...args], { ...options, env });
    child.unref();
    void pump_stdout(child.stdout, queue);
    void drain_stderr(child.stderr);
    return {
      write_line(line: string): void {
        child.stdin.write(`${line}\n`);
        void child.stdin.flush();
      },
      read_line(): Promise<string | undefined> {
        return queue.read();
      },
      stop(): void {
        child.kill();
      },
      failed(): string | undefined {
        return undefined;
      },
    };
  } catch (error) {
    const coded = error as { code?: string };
    return failed_child(spawn_failure(coded.code));
  }
}
