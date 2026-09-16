/**
 * Process B of the self-improvement e2e. work_dir is argv, never cwd.
 * Constructs an agent so the loader dynamic-imports the fixture plugin,
 * then asserts that tool is registered and returns the same output as a
 * direct call. Mock provider only — no network.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { create_agent_with_plugins } from "../../src/agent/agent.js";

interface FixtureTool {
  name: string;
  execute(
    args: Record<string, unknown>,
    context: { work_dir: string; env: Record<string, string> },
  ): Promise<{ output: string }>;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function chat_response(message: Record<string, unknown>, finish_reason: string): Response {
  const body = {
    model: "mock",
    choices: [{ message, finish_reason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  return new Response(JSON.stringify(body), { status: 200 });
}

const work_dir = process.argv[2];
if (work_dir === undefined || work_dir.length === 0) {
  fail("usage: self_improve_probe.ts <work_dir>");
}
if (path.resolve(process.cwd()) === path.resolve(work_dir)) {
  fail("work_dir must be pinned via argv, not process cwd");
}

const raw = JSON.parse(readFileSync(path.join(work_dir, ".lich", "config.json"), "utf8")) as { plugins?: string[] };
const entry = raw.plugins?.[0];
if (entry === undefined) {
  fail("fixture config has no plugins entry");
}

const imported = (await import(pathToFileURL(path.resolve(work_dir, entry)).href)) as { default?: { tools?: FixtureTool[] } };
const tool = imported.default?.tools?.[0];
if (tool === undefined) {
  fail("plugin exported no tool");
}

const direct = await tool.execute({}, { work_dir, env: {} });
let calls = 0;
const probe_state = { registered: false };
const fetch_fn: typeof fetch = (_input, init) => {
  calls += 1;
  if (calls === 1) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { tools?: Array<{ function?: { name?: string } }> };
    probe_state.registered = body.tools?.some((item) => item.function?.name === tool.name) === true;
    const message = {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "p1", type: "function", function: { name: tool.name, arguments: "{}" } }],
    };
    return Promise.resolve(chat_response(message, "tool_calls"));
  }
  return Promise.resolve(chat_response({ role: "assistant", content: "probe done" }, "stop"));
};

const agent = await create_agent_with_plugins({
  providers: [{ kind: "openai_compat", name: "probe", model: "mock", base_url: "http://127.0.0.1:9", fetch_fn }],
  work_dir,
  plugins: [entry],
  log_level: "error",
  max_turns: 4,
});
const result = await agent.run({ input: "call the fixture tool" });
const tool_message = result.messages.find((message) => message.role === "tool" && message.name === tool.name);
if (probe_state.registered !== true) {
  fail(`tool ${tool.name} was not registered`);
}
if (tool_message?.role !== "tool" || tool_message.content !== direct.output) {
  fail(`tool not functional: ${JSON.stringify(tool_message)}`);
}
console.log("probe_ok");
