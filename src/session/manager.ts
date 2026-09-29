/**
 * Per-session run queue. Different session ids run concurrently; the same id
 * is serialized (same gate pattern as serve's former global run_tail).
 */

export interface SessionManager {
  enqueue<T>(session_id: string, task: () => Promise<T>): Promise<T>;
  /** Live queue tails (test/observability); drops after idle sessions release. */
  pending_count(): number;
}

export function create_session_manager(): SessionManager {
  const tails = new Map<string, Promise<unknown>>();

  return {
    enqueue: async <T>(session_id: string, task: () => Promise<T>): Promise<T> => {
      const previous = tails.get(session_id) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const chained = previous.then(() => gate).catch(() => gate);
      tails.set(session_id, chained);

      await previous.catch(() => undefined);
      try {
        return await task();
      } finally {
        release();
        if (tails.get(session_id) === chained) {
          tails.delete(session_id);
        }
      }
    },
    pending_count: () => tails.size,
  };
}
