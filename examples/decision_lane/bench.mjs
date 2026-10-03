/**
 * Replays saved battle snapshots through System One and compares the picks with
 * what the LLM chose. Needs a local Ollama 0.35+ with the models pulled.
 *
 *   node examples/decision_lane/bench.mjs cases.jsonl [--base-url URL] [--models tev1:0.8b,nimble]
 *
 * Each cases.jsonl line: {"battle": <state.json snapshot>, "request"?: "...",
 * "llm_actions"?: [{"enemy_id","action","target_ref"}]}.
 */
import { readFile } from "node:fs/promises";
import { build_questions, normalize_battle, pick_actions } from "./round.mjs";
import { systemone } from "./systemone.mjs";

const THRESHOLDS = [0.6, 0.75, 0.9];

function parse_args(argv) {
  const args = { file: undefined, base_url: "http://localhost:11434", models: ["tev1:0.8b", "nimble"] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--base-url") {
      args.base_url = argv[(index += 1)];
    } else if (value === "--models") {
      args.models = argv[(index += 1)].split(",");
    } else {
      args.file = value;
    }
  }
  return args;
}

async function read_cases(file) {
  const lines = (await readFile(file, "utf8")).split("\n").filter((line) => line.trim().length > 0);
  return lines
    .map((line) => JSON.parse(line))
    .map((item) => ({ ...item, battle: normalize_battle(item.battle) }))
    .filter((item) => item.battle !== undefined);
}

/** Share of enemies whose action and target both match the LLM's order; undefined without one. */
function agreement(actions, llm_actions) {
  if (Array.isArray(llm_actions) === false || llm_actions.length === 0) {
    return undefined;
  }
  const by_enemy = new Map(llm_actions.map((action) => [action.enemy_id, action]));
  const matches = actions.filter((action) => {
    const llm = by_enemy.get(action.enemy_id);
    return llm !== undefined && llm.action === action.action && llm.target_ref === action.target_ref;
  });
  return matches.length / actions.length;
}

async function run_model(model, cases, base_url) {
  const rows = [];
  for (const item of cases) {
    try {
      const { answers, latency_ms } = await systemone({
        base_url,
        model,
        state: { battle: item.battle, request: item.request ?? "" },
        questions: build_questions(item.battle),
        timeout_ms: 10000,
      });
      const picked = pick_actions(item.battle, answers);
      rows.push({ latency_ms, min_confidence: picked.min_confidence, agree: agreement(picked.actions, item.llm_actions) });
    } catch (error) {
      rows.push({ error: error?.reason ?? String(error) });
    }
  }
  return rows;
}

function mean(values) {
  return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function fmt(value, digits = 2) {
  return value === undefined ? "-" : value.toFixed(digits);
}

function report(model, rows) {
  const ok = rows.filter((row) => row.error === undefined);
  const latencies = ok.map((row) => row.latency_ms).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length / 2)];
  console.log(`\n${model}: ${ok.length}/${rows.length} ok, p50 ${p50 ?? "-"} ms, mean ${fmt(mean(latencies), 0)} ms`);
  console.log("| threshold | coverage | agreement when covered |");
  console.log("| --- | --- | --- |");
  for (const threshold of THRESHOLDS) {
    const covered = ok.filter((row) => row.min_confidence >= threshold);
    const agree = mean(covered.map((row) => row.agree).filter((value) => value !== undefined));
    console.log(`| ${threshold} | ${fmt(covered.length / Math.max(rows.length, 1))} | ${fmt(agree)} |`);
  }
  const errors = rows.filter((row) => row.error !== undefined).map((row) => row.error);
  if (errors.length > 0) {
    console.log(`errors: ${[...new Set(errors)].join(", ")}`);
  }
}

const args = parse_args(process.argv.slice(2));
if (args.file === undefined) {
  console.error("usage: node examples/decision_lane/bench.mjs cases.jsonl [--base-url URL] [--models a,b]");
  process.exit(2);
}
const cases = await read_cases(args.file);
for (const model of args.models) {
  report(model, await run_model(model, cases, args.base_url));
}
