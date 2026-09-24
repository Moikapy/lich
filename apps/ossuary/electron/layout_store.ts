/**
 * Persist Dockview layout JSON under the agent work dir.
 * Renderer never touches the filesystem — main process only.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const LAYOUT_FILE_NAME = "ossuary-layout.json";

export function resolve_layout_path(work_dir: string): string {
  return path.join(work_dir, ".lich", LAYOUT_FILE_NAME);
}

/** Read layout JSON, or null when missing / unreadable / invalid JSON. */
export async function read_layout_file(work_dir: string): Promise<unknown | null> {
  const file = resolve_layout_path(work_dir);
  try {
    const text = await readFile(file, "utf8");
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Atomically write layout JSON into `.lich/ossuary-layout.json`. */
export async function write_layout_file(work_dir: string, layout: unknown): Promise<void> {
  const file = resolve_layout_path(work_dir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(layout)}\n`, "utf8");
  await rename(tmp, file);
}
