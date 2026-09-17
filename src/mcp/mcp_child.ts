export interface LineChild {
  write_line(line: string): void;
  read_line(): Promise<string | undefined>;
  stop(): void;
  failed(): string | undefined;
}

export type LineSpawner = (command: string, args: readonly string[], env?: Record<string, string>) => LineChild;

export function spawn_failure(code: string | undefined): string {
  if (code === "ENOENT") {
    return "mcp command not found";
  }
  return "mcp spawn failed";
}

export function failed_child(message: string): LineChild {
  return {
    write_line(): void {
      return undefined;
    },
    read_line(): Promise<string | undefined> {
      return Promise.resolve(undefined);
    },
    stop(): void {
      return undefined;
    },
    failed(): string | undefined {
      return message;
    },
  };
}
