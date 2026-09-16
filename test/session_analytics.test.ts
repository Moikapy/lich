/**
 * games.md jq recipes against a fixture JSONL and a mock-provider session.
 * No network. If jq is missing, filter text is checked against the golden file.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { create_agent_with_plugins } from "../src/agent/agent.js";
import { TMP_BASE } from "./helpers/tmp_base.js";
import { extract_recipes, run_jq, type Recipe } from "./session_recipes.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const GAMES = path.join(REPO, "docs/user-guide/games.md");
const FIXTURE = path.join(REPO, "test/fixtures/session_combat.jsonl");
const GOLDEN = path.join(REPO, "test/fixtures/session_recipe_filters.json");
const PLUGIN = path.join(REPO, "examples/game_bridge/game_bridge.plugin.mjs");

const temp_dirs: string[] = [];

afterAll(async () => {
  for (const dir of temp_dirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function make_temp_dir(): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(path.join(TMP_BASE, "session-analytics-"));
  temp_dirs.push(dir);
  return dir;
}

function jq_available(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("jq", ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function completion_body(message: Record<string, unknown>, finish_reason: string) {
  return {
    model: "mock-model",
    choices: [{ message, finish_reason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function tool_call_body(id: string, name: string, args: Record<string, unknown>) {
  return {
    role: "assistant",
    content: "",
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

function scripted_fetch(script: (call_count: number) => unknown): typeof fetch {
  let calls = 0;
  return () => {
    calls += 1;
    return Promise.resolve(new Response(JSON.stringify(script(calls)), { status: 200 }));
  };
}

async function recipe_map(markdown: string): Promise<Map<string, Recipe>> {
  const recipes = extract_recipes(markdown);
  return new Map(recipes.map((recipe) => [recipe.id, recipe]));
}

describe("session JSONL recipes", () => {
  it("matches the golden filters in games.md", async () => {
    const markdown = await readFile(GAMES, "utf8");
    const golden = JSON.parse(await readFile(GOLDEN, "utf8")) as Recipe[];
    expect(extract_recipes(markdown)).toEqual(golden);
    expect(golden.map((recipe) => recipe.id)).toEqual(["1", "2", "3", "4", "5", "usage", "memory"]);
  });

  it("runs each documented recipe against the combat fixture", async () => {
    if ((await jq_available()) === false) {
      return;
    }
    const recipes = await recipe_map(await readFile(GAMES, "utf8"));
    const rationale = await run_jq(require_recipe(recipes, "1"), [FIXTURE]);
    expect(rationale.trim().split("\n")).toEqual(["open with a strike", "finish it", "bad target"]);
    const histogram = JSON.parse(await run_jq(require_recipe(recipes, "2"), [FIXTURE])) as Array<{
      action: string;
      uses: number;
    }>;
    expect(histogram[0]).toEqual({ action: "attack", uses: 2 });
    expect(await run_jq(require_recipe(recipes, "3"), [FIXTURE])).toContain(
      "blocked_by_plugin: meteor_gates_closed_until_round_3",
    );
    const rejects = await run_jq(require_recipe(recipes, "4"), [FIXTURE]);
    expect(rejects).toContain("target_ref_must_be_hero_or_enemy");
    expect(rejects).toContain("not-json");
    const pacing = await run_jq(require_recipe(recipes, "5"), [FIXTURE]);
    expect(pacing).toContain("user");
    expect(pacing).toContain("assistant");
    expect((await run_jq(require_recipe(recipes, "usage"), [FIXTURE])).trim()).toBe("18");
    expect((await run_jq(require_recipe(recipes, "memory"), [FIXTURE])).trim()).toBe(
      "the player always heals below half",
    );
  });

  it("runs rationale, veto, and is_error recipes on a mock-provider session", async () => {
    const work_dir = await make_temp_dir();
    const fetch_fn = scripted_fetch((call_count) => {
      if (call_count === 1) {
        return completion_body(
          tool_call_body("t1", "enemy_actions", {
            round: 1,
            actions: [{ enemy_id: "goblin", action: "meteor", target_ref: "hero:hero1" }],
            rationale: "finish it",
          }),
          "tool_calls",
        );
      }
      if (call_count === 2) {
        return completion_body(
          tool_call_body("t2", "enemy_actions", {
            round: 1,
            actions: [{ enemy_id: "goblin", action: "attack", target_ref: "hero:hero1" }],
            rationale: "open with a strike",
          }),
          "tool_calls",
        );
      }
      return completion_body({ role: "assistant", content: "queued" }, "stop");
    });
    const agent = await create_agent_with_plugins({
      providers: [{ kind: "openai_compat", name: "mock", model: "mock-model", base_url: "http://mock.local/v1", fetch_fn }],
      work_dir,
      session_dir: path.join(work_dir, "sessions"),
      plugins: [PLUGIN],
      tools_enabled: [],
      log_level: "error",
    });
    const result = await agent.run({ input: "round 1 digest", label: "gw:webhook:npc:commander:run-1" });
    expect(result.session_path).toBeDefined();
    const session_path = result.session_path ?? "";
    const raw = await readFile(session_path, "utf8");
    expect(raw).toContain("open with a strike");
    expect(raw).toContain("blocked_by_plugin: meteor_gates_closed_until_round_3");
    if ((await jq_available()) === false) {
      return;
    }
    const recipes = await recipe_map(await readFile(GAMES, "utf8"));
    expect(await run_jq(require_recipe(recipes, "1"), [session_path])).toContain("open with a strike");
    const histogram = JSON.parse(await run_jq(require_recipe(recipes, "2"), [session_path])) as Array<{
      action: string;
      uses: number;
    }>;
    expect(histogram).toEqual(
      expect.arrayContaining([
        { action: "attack", uses: 1 },
        { action: "meteor", uses: 1 },
      ]),
    );
    expect(await run_jq(require_recipe(recipes, "3"), [session_path])).toContain(
      "blocked_by_plugin: meteor_gates_closed_until_round_3",
    );
    expect(await run_jq(require_recipe(recipes, "4"), [session_path])).toContain(
      "blocked_by_plugin: meteor_gates_closed_until_round_3",
    );
  });
});

function require_recipe(recipes: Map<string, Recipe>, id: string): Recipe {
  const recipe = recipes.get(id);
  if (recipe === undefined) {
    throw new Error(`missing recipe ${id}`);
  }
  return recipe;
}
