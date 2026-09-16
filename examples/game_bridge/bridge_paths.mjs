import path from "node:path";

export const ORDERS_FILE = "orders.jsonl";
export const MEMORY_FILE = "memory.jsonl";
export const STATE_FILE = "state.json";
/** Most recent notes returned by dungeon_memory_read; writes stay append-only. */
export const MEMORY_READ_LIMIT = 20;

export function game_file(work_dir, file_name) {
  return path.join(work_dir, ".lich", "game", file_name);
}
