import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export function tool_failure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, output: "", error: message };
}

export async function ensure_game_dir(work_dir) {
  await mkdir(path.join(work_dir, ".lich", "game"), { recursive: true });
}

export async function append_jsonl(file_path, record) {
  let line;
  try {
    line = JSON.stringify(record);
  } catch (error) {
    return tool_failure(error);
  }
  await appendFile(file_path, `${line}\n`, "utf8");
  return { ok: true };
}

export async function read_jsonl_records(file_path) {
  let raw = "";
  try {
    raw = await readFile(file_path, "utf8");
  } catch (error) {
    if (is_missing(error) === true) {
      return [];
    }
    throw error;
  }
  const records = [];
  for (const line of raw.split("\n")) {
    const parsed = parse_line(line);
    if (parsed !== undefined) {
      records.push(parsed);
    }
  }
  return records;
}

function parse_line(line) {
  if (line.length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}
function is_missing(error) {
  return typeof error === "object" && error !== null && error.code === "ENOENT";
}
