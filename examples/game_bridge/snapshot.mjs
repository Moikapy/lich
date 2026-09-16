import { readFile } from "node:fs/promises";
import { STATE_FILE, game_file } from "./bridge_paths.mjs";

/** Godot may refresh state.json; a missing or partial snapshot is not an error. */
export async function read_snapshot_round(work_dir) {
  try {
    const raw = await readFile(game_file(work_dir, STATE_FILE), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    if (typeof parsed.round !== "number" || Number.isFinite(parsed.round) === false) {
      return undefined;
    }
    return parsed.round;
  } catch {
    return undefined;
  }
}
