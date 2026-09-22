/**
 * Resolve a `--resume` value to an existing session transcript path.
 * Pure filesystem lookup: latest by mtime, exact id, or unique prefix.
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export interface SessionFileInfo {
  readonly name: string;
  readonly id: string;
  readonly mtime_ms: number;
}

const CANDIDATE_CAP = 5;

function is_enoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

async function list_session_files(dir: string): Promise<SessionFileInfo[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (is_enoent(error) === true) {
      return [];
    }
    throw error;
  }
  const entries: SessionFileInfo[] = [];
  for (const name of names) {
    if (name.endsWith(".jsonl") === false) {
      continue;
    }
    try {
      const info = await stat(path.join(dir, name));
      if (info.isFile() === false) {
        continue;
      }
      entries.push({ name, id: name.slice(0, -".jsonl".length), mtime_ms: info.mtimeMs });
    } catch {
      continue;
    }
  }
  return entries.sort((a, b) => b.mtime_ms - a.mtime_ms);
}

function candidate_ids(entries: readonly SessionFileInfo[]): string {
  if (entries.length === 0) {
    return "(none)";
  }
  return entries
    .slice(0, CANDIDATE_CAP)
    .map((entry) => entry.id)
    .join(", ");
}

function missing_error(dir: string, value: string, entries: readonly SessionFileInfo[]): Error {
  return new Error(`session not found: "${value}" in ${dir} (candidates: ${candidate_ids(entries)})`);
}

function ambiguous_error(dir: string, value: string, matches: readonly SessionFileInfo[]): Error {
  const sorted = [...matches].sort((a, b) => b.mtime_ms - a.mtime_ms);
  return new Error(`ambiguous session prefix: "${value}" in ${dir} matches: ${candidate_ids(sorted)}`);
}

/** Map `(dir, value)` to an absolute transcript path, or throw with candidates. */
export async function resolve_session_path(dir: string, value: string): Promise<string> {
  const entries = await list_session_files(dir);
  if (value === "latest") {
    const newest = entries[0];
    if (newest === undefined) {
      throw missing_error(dir, value, entries);
    }
    return path.join(dir, newest.name);
  }
  const exact_name = `${value}.jsonl`;
  const exact = entries.find((entry) => entry.name === exact_name);
  if (exact !== undefined) {
    return path.join(dir, exact.name);
  }
  const prefix_matches = entries.filter((entry) => entry.id.startsWith(value));
  if (prefix_matches.length === 1) {
    return path.join(dir, prefix_matches[0]!.name);
  }
  if (prefix_matches.length > 1) {
    throw ambiguous_error(dir, value, prefix_matches);
  }
  throw missing_error(dir, value, entries);
}
