/**
 * Two-process self-improvement e2e (docs/design/self-improvement-loop.md
 * Demo & tests). Process A writes a tool and a bun test, runs them, and
 * commits. Process B is a fresh bun subprocess with work_dir pinned via argv.
 */
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { create_agent, type AgentRunResult } from "../src/agent/agent.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const PROBE = fileURLToPath(new URL("./fixtures/self_improve_probe.ts", import.meta.url));
const GREET_OUTPUT = "fixture_greet_ok";
const PLUGIN_REL = ".lich/plugins/greet.plugin.ts";
const TEST_REL = "greet.test.ts";
const dirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

function git(dir: string, args: readonly string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
      (err, stdout, stderr) => {
        resolve({ code: err === null ? 0 : 1, out: `${stdout}${stderr}` });
      },
    );
  });
}

function plugin_source(): string {
  return [
    "const greet_tool = {",
    '  name: "greet_fixture",',
    '  description: "Return a fixed greeting for the fixture.",',
    '  parameters: { type: "object", properties: {}, additionalProperties: false },',
    `  execute: async () => ({ ok: true, output: "${GREET_OUTPUT}" }),`,
    "};",
    'const greet_plugin = { name: "greet_fixture", tools: [greet_tool] };',
    "export default greet_plugin;",
    "",
  ].join("\n");
}

function test_source(): string {
  return [
    'import { expect, test } from "bun:test";',
    `import plugin from "./${PLUGIN_REL}";`,
    "",
    'test("greet_fixture works", async () => {',
    "  const tool = plugin.tools[0];",
    '  const result = await tool.execute({}, { work_dir: ".", env: {} });',
    "  expect(result.ok).toBe(true);",
    `  expect(result.output).toBe("${GREET_OUTPUT}");`,
    "});",
    "",
  ].join("\n");
}

function chat_body(message: Record<string, unknown>, finish_reason: string): { status: number; body: unknown } {
  return {
    status: 200,
    body: {
      model: "mock-model",
      choices: [{ message, finish_reason }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    },
  };
}

function tool_call(id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    role: "assistant",
    content: "",
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

function scripted_fetch(): typeof fetch {
  const steps: Array<{ status: number; body: unknown }> = [
    chat_body(tool_call("t1", "write_file", { path: PLUGIN_REL, content: plugin_source() }), "tool_calls"),
    chat_body(tool_call("t2", "write_file", { path: TEST_REL, content: test_source() }), "tool_calls"),
    chat_body(tool_call("t3", "run_tests", {}), "tool_calls"),
    chat_body(
      tool_call("t4", "git_commit", { message: "feat: add greet_fixture tool", paths: [PLUGIN_REL, TEST_REL] }),
      "tool_calls",
    ),
    chat_body({ role: "assistant", content: "committed greet_fixture" }, "stop"),
  ];
  let calls = 0;
  return (_input, _init) => {
    calls += 1;
    const step = steps[calls - 1] ?? steps[steps.length - 1];
    return Promise.resolve(new Response(JSON.stringify(step?.body), { status: step?.status ?? 500 }));
  };
}

async function seed_fixture(): Promise<{ dir: string; seed_sha: string }> {
  const dir = await mkdtemp(path.join(TMP_BASE, "self-improve-"));
  dirs.push(dir);
  await mkdir(path.join(dir, ".lich"), { recursive: true });
  const config = { plugins: [PLUGIN_REL] };
  await writeFile(path.join(dir, ".lich", "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  expect((await git(dir, ["init"])).code).toBe(0);
  expect((await git(dir, ["add", "--", ".lich/config.json"])).code).toBe(0);
  const commit = await git(dir, ["-c", "user.name=lich", "-c", "user.email=lich@localhost", "commit", "-m", "seed"]);
  expect(commit.code).toBe(0);
  const sha = await git(dir, ["rev-parse", "HEAD"]);
  return { dir, seed_sha: sha.out.trim() };
}

function restore_env(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function tool_text(result: AgentRunResult, name: string): string {
  const message = result.messages.find((item) => item.role === "tool" && item.name === name);
  expect(message?.role).toBe("tool");
  if (message?.role !== "tool") {
    return "";
  }
  expect(message.is_error).not.toBe(true);
  return message.content;
}

function run_probe(work_dir: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("bun", [PROBE, work_dir], { cwd: "/tmp", env: process.env });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", (err) => resolve({ code: 1, out: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

describe("self-improvement two-process e2e", () => {
  it("writes a tool, commits once on the seed, and a fresh process loads it", async () => {
    const saved = {
      allow: process.env["LICH_ALLOW_SELF_COMMIT"],
      test_cmd: process.env["LICH_TEST_COMMAND"],
      git_global: process.env["GIT_CONFIG_GLOBAL"],
      git_system: process.env["GIT_CONFIG_NOSYSTEM"],
    };
    process.env["LICH_ALLOW_SELF_COMMIT"] = "1";
    process.env["LICH_TEST_COMMAND"] = "bun test";
    process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
    process.env["GIT_CONFIG_NOSYSTEM"] = "1";
    try {
      const { dir, seed_sha } = await seed_fixture();
      const agent = create_agent({
        providers: [{ kind: "openai_compat", name: "mock", model: "mock-model", base_url: "http://127.0.0.1:9", fetch_fn: scripted_fetch() }],
        work_dir: dir,
        session_dir: path.join(dir, ".lich", "sessions"),
        log_level: "error",
        max_turns: 8,
      });
      const result = await agent.run({ input: "add greet_fixture, test it, and commit" });
      expect(result.outcome.stopped_reason).toBe("final");
      const tests = tool_text(result, "run_tests");
      expect(tests).toContain("greet_fixture works");
      expect(tests).toContain("[exit 0]");
      const committed = tool_text(result, "git_commit");
      expect(committed).toContain(PLUGIN_REL);
      expect(committed).toContain(TEST_REL);

      const count = await git(dir, ["rev-list", "--count", "HEAD"]);
      expect(count.out.trim()).toBe("2");
      const parent = await git(dir, ["rev-parse", "HEAD^"]);
      expect(parent.out.trim()).toBe(seed_sha);

      const probe = await run_probe(dir);
      expect(probe.out).toContain("probe_ok");
      expect(probe.code).toBe(0);
    } finally {
      restore_env("LICH_ALLOW_SELF_COMMIT", saved.allow);
      restore_env("LICH_TEST_COMMAND", saved.test_cmd);
      restore_env("GIT_CONFIG_GLOBAL", saved.git_global);
      restore_env("GIT_CONFIG_NOSYSTEM", saved.git_system);
    }
  }, 300_000);
});
