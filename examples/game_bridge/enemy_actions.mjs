import { append_jsonl, ensure_game_dir, tool_failure } from "./bridge_io.mjs";
import { ORDERS_FILE, game_file } from "./bridge_paths.mjs";
import { read_snapshot_round } from "./snapshot.mjs";
import { enemy_actions_schema } from "./schemas.mjs";
import { normalize_actions, validate_enemy_actions } from "./validate_order.mjs";

export const enemy_actions_tool = {
  name: "enemy_actions",
  description: "Queue every enemy action for one combat round. Godot drains the order next tick.",
  parameters: enemy_actions_schema,
  execute: queue_enemy_actions,
};

async function queue_enemy_actions(args, context) {
  const problem = validate_enemy_actions(args);
  if (problem !== undefined) {
    return { ok: false, output: "", error: problem };
  }
  try {
    await ensure_game_dir(context.work_dir);
    const actions = normalize_actions(args.actions);
    const written = await append_jsonl(game_file(context.work_dir, ORDERS_FILE), {
      ts: new Date().toISOString(),
      round: args.round,
      actions,
      rationale: args.rationale,
    });
    if (written.ok === false) {
      return { ok: false, output: "", error: written.error };
    }
    const snapshot_round = await read_snapshot_round(context.work_dir);
    return { ok: true, output: format_count(actions.length, args.round, snapshot_round) };
  } catch (error) {
    return tool_failure(error);
  }
}

function format_count(count, round, snapshot_round) {
  const base = `appended ${count} orders for round ${round}`;
  if (snapshot_round === undefined || snapshot_round === round) {
    return base;
  }
  return `${base}; snapshot_round_mismatch: snapshot=${snapshot_round}`;
}
