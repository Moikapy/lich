/**
 * GatewayBus patterns, copied as functions: history cap, oldest-first
 * eviction, per-conversation promise chain. Not a second agent loop.
 */

export const DEFAULT_HISTORY_CAP = 40;
export const DEFAULT_MAX_CONVERSATIONS = 200;

/** Newest `cap` messages. A cap of N drops the oldest overflow, not the system prompt. */
export function cap_history<T>(messages: readonly T[], cap: number): T[] {
  const overflow = messages.length - cap;
  if (overflow <= 0) {
    return [...messages];
  }
  return messages.slice(overflow);
}

/**
 * Recalls the value for `key`, dropping oldest keys first when the map is
 * already at `max_entries` and this key is new. Mutates `map` like GatewayBus.
 */
export function recall_history<T>(map: Map<string, T>, key: string, max_entries: number): T | undefined {
  let dropped = 0;
  while (map.size >= max_entries && map.has(key) === false && dropped < max_entries) {
    const oldest = map.keys().next();
    if (oldest.done === true) {
      break;
    }
    map.delete(oldest.value);
    dropped += 1;
  }
  return map.get(key);
}

/** Serializes tasks for one key. A rejected task does not stall the next. */
export function enqueue<T>(chains: Map<string, Promise<void>>, key: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(task);
  chains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
