/** Line queue for a stdio MCP pipe. No recursion. */
export interface LineQueue {
  push(line: string): void;
  close(): void;
  read(): Promise<string | undefined>;
}

export function create_line_queue(): LineQueue {
  const pending: string[] = [];
  const waiters: Array<(line: string | undefined) => void> = [];
  let closed = false;
  return {
    push(line: string): void {
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter(line);
        return;
      }
      pending.push(line);
    },
    close(): void {
      closed = true;
      for (const waiter of waiters.splice(0)) {
        waiter(undefined);
      }
    },
    read(): Promise<string | undefined> {
      const next = pending.shift();
      if (next !== undefined) {
        return Promise.resolve(next);
      }
      if (closed === true) {
        return Promise.resolve(undefined);
      }
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}
