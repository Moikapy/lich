/**
 * Decision lane: asks a local decision model (Ollama System One) to pick each
 * enemy's action for the current game_bridge round before the LLM turn.
 *
 * mode "shadow" (default) only logs. mode "act" queues the orders when every
 * answer clears `threshold`; the orders still pass game_bridge's validation and
 * meteor veto, so the model's verdict never bypasses a deterministic check.
 * Any failure, low confidence, or veto falls back to the normal LLM turn.
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { enemy_actions_tool } from "../game_bridge/enemy_actions.mjs";
import { game_file } from "../game_bridge/bridge_paths.mjs";
import { meteor_veto } from "../game_bridge/meteor_veto.mjs";
import { build_questions, pick_actions, read_battle } from "./round.mjs";
import { systemone } from "./systemone.mjs";

export const DEFAULT_SETTINGS = Object.freeze({
  mode: "shadow",
  base_url: "http://localhost:11434",
  model: "nimble",
  threshold: 0.75,
  timeout_ms: 2000,
  log_file: "decisions.jsonl",
  api_key_env: undefined,
});

/** The last user message is sent as context; capped so the payload stays small. */
const REQUEST_MAX_CHARS = 2000;

async function decide_round(info, ctx) {
  const settings = { ...DEFAULT_SETTINGS, ...ctx.settings };
  const battle = await read_battle(ctx.work_dir);
  if (battle === undefined || ctx.state?.get("decided_round") === battle.round) {
    return undefined;
  }
  ctx.state?.set("decided_round", battle.round);
  const record = { ts: new Date().toISOString(), mode: settings.mode, model: settings.model, round: battle.round };
  try {
    const { answers, latency_ms } = await systemone({
      base_url: settings.base_url,
      model: settings.model,
      state: { battle, request: last_user_text(info.messages) },
      questions: build_questions(battle),
      timeout_ms: settings.timeout_ms,
      api_key: settings.api_key_env === undefined ? undefined : process.env[settings.api_key_env],
    });
    const picked = pick_actions(battle, answers);
    Object.assign(record, { latency_ms, min_confidence: picked.min_confidence, answers: picked.log });
    return await act_on(picked, battle, settings, ctx, record);
  } catch (error) {
    record.outcome = "fallback";
    record.fallback_reason = typeof error?.reason === "string" ? error.reason : "error";
    return undefined;
  } finally {
    await write_log(ctx.work_dir, settings.log_file, record);
  }
}

async function act_on(picked, battle, settings, ctx, record) {
  if (settings.mode !== "act") {
    record.outcome = "shadow";
    return undefined;
  }
  if (picked.min_confidence < settings.threshold) {
    return fallback(record, "low_confidence");
  }
  const args = {
    round: battle.round,
    actions: picked.actions,
    rationale: `decision_lane ${settings.model} min_confidence=${picked.min_confidence.toFixed(2)}`,
  };
  const veto = await meteor_veto({ tool_name: "enemy_actions", args });
  if (veto?.block === true) {
    return fallback(record, `vetoed:${veto.reason}`);
  }
  const result = await enemy_actions_tool.execute(args, { work_dir: ctx.work_dir, env: {} });
  if (result.ok === false) {
    return fallback(record, `order_rejected:${result.error}`);
  }
  record.outcome = "acted";
  const summary = picked.actions.map((action) => `${action.enemy_id}:${action.action}->${action.target_ref}`).join(", ");
  return {
    note: `The decision lane already queued round ${battle.round} orders (${summary}). Do not call enemy_actions again for round ${battle.round}; reply briefly.`,
  };
}

function fallback(record, reason) {
  record.outcome = "fallback";
  record.fallback_reason = reason;
  return undefined;
}

function last_user_text(messages) {
  const last = [...messages].reverse().find((message) => message.role === "user");
  return typeof last?.content === "string" ? last.content.slice(0, REQUEST_MAX_CHARS) : "";
}

/** One JSONL line per decision; a log failure never breaks the run. */
async function write_log(work_dir, log_file, record) {
  try {
    const file = game_file(work_dir, log_file);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Logging is best-effort.
  }
}

const decision_lane = {
  name: "decision_lane",
  hooks: {
    before_llm_call: decide_round,
  },
};

export default decision_lane;
