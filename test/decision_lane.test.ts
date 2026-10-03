/**
 * decision_lane example (#148 part B): System One client limits and wire shape,
 * plus the plugin's shadow / act / fallback paths against a fake local server.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { load_plugins } from "../src/plugins/loader.js";
import type { HookContext, Plugin } from "../src/plugins/types.js";
import type { Message } from "../src/providers/types.js";
import { TMP_BASE } from "./helpers/tmp_base.js";
// @ts-expect-error plain .mjs example without type declarations
import { DecisionError, systemone } from "../examples/decision_lane/systemone.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN = "./examples/decision_lane/decision_lane.plugin.mjs";
const temp_dirs: string[] = [];

interface Received {
  url: string;
  body: { model: string; questions: Record<string, { type: string; criteria: Record<string, string> }> };
}

let server: Server;
let base_url = "";
let received: Received[] = [];
let reply: (body: Received["body"]) => { status: number; json: unknown } = () => ({ status: 200, json: {} });

beforeAll(async () => {
  server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const body = JSON.parse(raw) as Received["body"];
      received.push({ url: request.url ?? "", body });
      const { status, json } = reply(body);
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base_url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of temp_dirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function game_dir(state: unknown): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(path.join(TMP_BASE, "decision-lane-"));
  temp_dirs.push(dir);
  if (state !== undefined) {
    await mkdir(path.join(dir, ".lich", "game"), { recursive: true });
    await writeFile(path.join(dir, ".lich", "game", "state.json"), JSON.stringify(state));
  }
  return dir;
}

/** Answer every choice with its first criterion at the given confidence. */
function confident(confidence: number) {
  return (body: Received["body"]) => ({
    status: 200,
    json: {
      model: body.model,
      answers: Object.fromEntries(
        Object.entries(body.questions).map(([name, question]) => [
          name,
          { type: "choice", choice: Object.keys(question.criteria)[0], confidence },
        ]),
      ),
    },
  });
}

async function load_lane(settings: Record<string, unknown>): Promise<{ plugin: Plugin; settings: Readonly<Record<string, unknown>> }> {
  const { plugins, errors } = await load_plugins([{ path: PLUGIN, settings: { base_url, ...settings } }], REPO);
  expect(errors).toEqual([]);
  const loaded = plugins[0];
  if (loaded === undefined || loaded.settings === undefined) {
    throw new Error("plugin did not load");
  }
  return { plugin: loaded.plugin, settings: loaded.settings };
}

const messages: Message[] = [{ role: "user", content: "Round starts. Decide the enemy turn." }];

async function run_hook(work_dir: string, settings: Record<string, unknown>, state = new Map<string, unknown>()) {
  const lane = await load_lane(settings);
  const ctx: HookContext = { work_dir, settings: lane.settings, state };
  return await lane.plugin.hooks?.before_llm_call?.({ turn: 1, messages }, ctx);
}

async function read_lines(file: string): Promise<Record<string, unknown>[]> {
  try {
    return (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

const battle = {
  round: 1,
  heroes: [{ id: "hero1" }, { id: "hero2" }],
  enemies: [{ id: "goblin", kit: ["slash"] }, { id: "slime" }],
};

describe("systemone client", () => {
  it("posts the documented shape with an optional Bearer key", async () => {
    let seen: { url: string; init: RequestInit | undefined } | undefined;
    const fetch_fn: typeof fetch = async (url, init) => {
      seen = { url: String(url), init };
      return new Response(JSON.stringify({ answers: { a: { type: "noul", noul: 0.9 } } }), { status: 200 });
    };
    const out = await systemone({
      base_url: "http://h:1/",
      model: "nimble",
      state: { x: 1 },
      questions: { a: { type: "noul", instructions: "?" } },
      api_key: "k",
      fetch_fn,
    });
    expect(seen?.url).toBe("http://h:1/v1/systemone");
    expect(JSON.parse(String(seen?.init?.body))).toEqual({
      model: "nimble",
      state: { x: 1 },
      questions: { a: { type: "noul", instructions: "?" } },
    });
    expect((seen?.init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer k");
    expect(out.answers.a.noul).toBe(0.9);
  });

  it("rejects out-of-limit requests before sending", async () => {
    const fetch_fn: typeof fetch = async () => {
      throw new Error("must not be called");
    };
    const base = { base_url: "http://h", model: "m", state: "s", fetch_fn };
    const choice = (count: number) => ({
      type: "choice",
      criteria: Object.fromEntries(Array.from({ length: count }, (_unused, index) => [`o${index}`, "x"])),
    });
    await expect(systemone({ ...base, questions: {} })).rejects.toMatchObject({ reason: "question_count" });
    await expect(systemone({ ...base, questions: { q: choice(1) } })).rejects.toMatchObject({ reason: "criteria_count" });
    await expect(systemone({ ...base, questions: { q: choice(27) } })).rejects.toMatchObject({ reason: "criteria_count" });
    await expect(
      systemone({ ...base, state: "x".repeat(70 * 1024), questions: { q: choice(2) } }),
    ).rejects.toMatchObject({ reason: "body_too_large" });
  });

  it("maps HTTP errors and timeouts to reasons", async () => {
    const questions = { q: { type: "noul", instructions: "?" } };
    const http_404: typeof fetch = async () => new Response("{}", { status: 404 });
    await expect(systemone({ base_url: "http://h", model: "m", state: "s", questions, fetch_fn: http_404 })).rejects.toMatchObject({
      reason: "http_404",
    });
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const timed = systemone({ base_url: "http://h", model: "m", state: "s", questions, fetch_fn: hang, timeout_ms: 20 });
    await expect(timed).rejects.toBeInstanceOf(DecisionError);
    await expect(timed).rejects.toMatchObject({ reason: "timeout" });
  });
});

describe("decision_lane plugin", () => {
  it("shadow mode logs the decision and changes nothing", async () => {
    received = [];
    reply = confident(0.95);
    const dir = await game_dir(battle);
    const result = await run_hook(dir, {});
    expect(result).toBeUndefined();
    expect(received[0]?.url).toBe("/v1/systemone");
    expect(Object.keys(received[0]?.body.questions ?? {})).toEqual(["e0_action", "e0_target", "e1_action", "e1_target"]);
    expect(Object.keys(received[0]?.body.questions["e0_action"]?.criteria ?? {})).toEqual(["slash", "attack", "defend", "flee"]);
    const log = await read_lines(path.join(dir, ".lich/game/decisions.jsonl"));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ mode: "shadow", model: "nimble", round: 1, outcome: "shadow", min_confidence: 0.95 });
    expect(await read_lines(path.join(dir, ".lich/game/orders.jsonl"))).toEqual([]);
  });

  it("act mode queues validated orders and returns a note when every answer clears the threshold", async () => {
    reply = confident(0.9);
    const dir = await game_dir(battle);
    const result = await run_hook(dir, { mode: "act", threshold: 0.75 });
    expect(result?.note).toContain("already queued round 1 orders");
    const orders = await read_lines(path.join(dir, ".lich/game/orders.jsonl"));
    expect(orders[0]).toMatchObject({
      round: 1,
      actions: [
        { enemy_id: "goblin", action: "slash", target_ref: "hero:hero1" },
        { enemy_id: "slime", action: "attack", target_ref: "hero:hero1" },
      ],
    });
    const log = await read_lines(path.join(dir, ".lich/game/decisions.jsonl"));
    expect(log[0]).toMatchObject({ outcome: "acted" });
  });

  it("falls back to the LLM on low confidence", async () => {
    reply = confident(0.5);
    const dir = await game_dir(battle);
    expect(await run_hook(dir, { mode: "act", threshold: 0.75 })).toBeUndefined();
    expect(await read_lines(path.join(dir, ".lich/game/orders.jsonl"))).toEqual([]);
    const log = await read_lines(path.join(dir, ".lich/game/decisions.jsonl"));
    expect(log[0]).toMatchObject({ outcome: "fallback", fallback_reason: "low_confidence" });
  });

  it("never bypasses the meteor veto", async () => {
    reply = confident(0.99);
    const dir = await game_dir({ round: 1, heroes: [{ id: "hero1" }], enemies: [{ id: "mage", kit: ["meteor"] }] });
    expect(await run_hook(dir, { mode: "act" })).toBeUndefined();
    expect(await read_lines(path.join(dir, ".lich/game/orders.jsonl"))).toEqual([]);
    const log = await read_lines(path.join(dir, ".lich/game/decisions.jsonl"));
    expect(log[0]).toMatchObject({ outcome: "fallback", fallback_reason: "vetoed:meteor_gates_closed_until_round_3" });
  });

  it("fails open when the server is unreachable", async () => {
    const dir = await game_dir(battle);
    expect(await run_hook(dir, { mode: "act", base_url: "http://127.0.0.1:1" })).toBeUndefined();
    const log = await read_lines(path.join(dir, ".lich/game/decisions.jsonl"));
    expect(log[0]).toMatchObject({ outcome: "fallback", fallback_reason: "network" });
  });

  it("skips without a snapshot and decides each round once per run", async () => {
    received = [];
    reply = confident(0.9);
    expect(await run_hook(await game_dir(undefined), {})).toBeUndefined();
    expect(received).toHaveLength(0);
    const dir = await game_dir(battle);
    const state = new Map<string, unknown>();
    await run_hook(dir, {}, state);
    await run_hook(dir, {}, state);
    expect(received).toHaveLength(1);
  });
});
