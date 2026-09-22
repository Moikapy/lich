import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { create_line_queue } from "./mcp_lines.js";
import { spawn_failure, type LineChild } from "./mcp_child.js";

function child_env(extra: Record<string, string> | undefined): NodeJS.ProcessEnv | undefined {
  if (extra === undefined) {
    return undefined;
  }
  const merged: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      merged[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    merged[key] = value;
  }
  return merged;
}

export function node_line_child(command: string, args: readonly string[], env?: Record<string, string>): LineChild {
  const queue = create_line_queue();
  let failure: string | undefined;
  const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], env: child_env(env) });
  child.unref();
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    queue.push(line);
  });
  reader.on("close", () => {
    queue.close();
  });
  child.stderr?.resume();
  child.stdin?.on("error", () => {
    // EPIPE when the child exits mid-write must not become an uncaught exception.
    failure ??= "mcp closed the pipe";
    queue.close();
  });
  child.on("error", (error: NodeJS.ErrnoException) => {
    failure = spawn_failure(error.code);
    queue.close();
  });
  return {
    write_line(line: string): void {
      child.stdin?.write(`${line}\n`);
    },
    read_line(): Promise<string | undefined> {
      return queue.read();
    },
    stop(): void {
      child.kill();
    },
    failed(): string | undefined {
      return failure;
    },
  };
}
