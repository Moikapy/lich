/**
 * Turns the game_bridge battle snapshot into System One questions and maps the
 * answers back to `enemy_actions` orders.
 */
import { readFile } from "node:fs/promises";
import { STATE_FILE, game_file } from "../game_bridge/bridge_paths.mjs";
import { DecisionError, SYSTEMONE_LIMITS } from "./systemone.mjs";

const BASIC_ACTIONS = Object.freeze({
  attack: "Basic attack on one hero",
  defend: "Defend this round",
  flee: "Try to flee the battle",
});

/** `{ round, heroes: [id], enemies: [{ id, kit: [ability] }] }`, or undefined when unusable. */
export async function read_battle(work_dir) {
  try {
    return normalize_battle(JSON.parse(await readFile(game_file(work_dir, STATE_FILE), "utf8")));
  } catch {
    return undefined;
  }
}

/** Same shape check as read_battle, for snapshots already in memory (bench replay). */
export function normalize_battle(parsed) {
  if (typeof parsed?.round !== "number" || Number.isFinite(parsed.round) === false) {
    return undefined;
  }
  const heroes = ids_of(parsed.heroes);
  const enemies = (Array.isArray(parsed.enemies) ? parsed.enemies : [])
    .filter((enemy) => typeof enemy?.id === "string" && enemy.id.length > 0)
    .map((enemy) => ({ id: enemy.id, kit: strings_of(enemy.kit) }));
  if (heroes.length === 0 || enemies.length === 0) {
    return undefined;
  }
  return { round: parsed.round, heroes, enemies };
}

/** One `choice` per enemy for its action, plus one for its target when there is more than one hero. */
export function build_questions(battle) {
  const questions = {};
  battle.enemies.forEach((enemy, index) => {
    questions[`e${index}_action`] = {
      type: "choice",
      instructions: `Which action should enemy "${enemy.id}" take this round?`,
      criteria: action_criteria(enemy.kit),
    };
    if (battle.heroes.length > 1) {
      questions[`e${index}_target`] = {
        type: "choice",
        instructions: `Which hero should enemy "${enemy.id}" target this round?`,
        criteria: Object.fromEntries(battle.heroes.map((id) => [`hero:${id}`, `Hero ${id}`])),
      };
    }
  });
  if (Object.keys(questions).length > SYSTEMONE_LIMITS.max_questions) {
    throw new DecisionError("too_many_enemies");
  }
  return questions;
}

/** Orders plus the lowest confidence across every answer; a missing answer counts as 0. */
export function pick_actions(battle, answers) {
  let min_confidence = 1;
  const log = {};
  const actions = battle.enemies.map((enemy, index) => {
    const action = read_choice(answers[`e${index}_action`]);
    const target =
      battle.heroes.length > 1
        ? read_choice(answers[`e${index}_target`])
        : { choice: `hero:${battle.heroes[0]}`, confidence: 1 };
    min_confidence = Math.min(min_confidence, action.confidence, target.confidence);
    log[enemy.id] = { action, target };
    return { enemy_id: enemy.id, action: action.choice, target_ref: target.choice };
  });
  return { actions, min_confidence, log };
}

function action_criteria(kit) {
  const criteria = {};
  for (const ability of kit) {
    criteria[ability] = `Use ability ${ability}`;
  }
  for (const [action, description] of Object.entries(BASIC_ACTIONS)) {
    criteria[action] ??= description;
  }
  if (Object.keys(criteria).length > SYSTEMONE_LIMITS.max_criteria) {
    throw new DecisionError("kit_too_large");
  }
  return criteria;
}

function read_choice(answer) {
  const choice = typeof answer?.choice === "string" ? answer.choice : "";
  const confidence = typeof answer?.confidence === "number" ? answer.confidence : 0;
  return { choice, confidence: choice.length > 0 ? confidence : 0 };
}

function ids_of(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => item?.id)
    .filter((id) => typeof id === "string" && id.length > 0);
}

function strings_of(list) {
  return (Array.isArray(list) ? list : []).filter((item) => typeof item === "string" && item.length > 0);
}
