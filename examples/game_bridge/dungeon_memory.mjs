import { append_jsonl, ensure_game_dir, read_jsonl_records, tool_failure } from "./bridge_io.mjs";
import { MEMORY_FILE, MEMORY_READ_LIMIT, game_file } from "./bridge_paths.mjs";
import { dungeon_memory_read_schema, dungeon_memory_write_schema } from "./schemas.mjs";

export const dungeon_memory_read_tool = {
  name: "dungeon_memory_read",
  description: "Read the most recent durable cross-run notes about the player.",
  parameters: dungeon_memory_read_schema,
  execute: read_memory,
};

export const dungeon_memory_write_tool = {
  name: "dungeon_memory_write",
  description: "Append one durable cross-run observation about the player.",
  parameters: dungeon_memory_write_schema,
  execute: write_memory,
};

async function read_memory(_args, context) {
  try {
    const records = await read_jsonl_records(game_file(context.work_dir, MEMORY_FILE));
    const notes = recent_notes(records);
    return { ok: true, output: notes.length > 0 ? notes.join("\n") : "(none)" };
  } catch (error) {
    return tool_failure(error);
  }
}

async function write_memory(args, context) {
  if (typeof args.note !== "string" || args.note.length === 0) {
    return { ok: false, output: "", error: "note_required" };
  }
  try {
    await ensure_game_dir(context.work_dir);
    const written = await append_jsonl(game_file(context.work_dir, MEMORY_FILE), {
      ts: new Date().toISOString(),
      note: args.note,
    });
    if (written.ok === false) {
      return { ok: false, output: "", error: written.error };
    }
    return { ok: true, output: "appended 1 note" };
  } catch (error) {
    return tool_failure(error);
  }
}

function recent_notes(records) {
  const notes = [];
  for (const record of records) {
    if (typeof record.note === "string") {
      notes.push(record.note);
    }
  }
  return notes.slice(-MEMORY_READ_LIMIT);
}
