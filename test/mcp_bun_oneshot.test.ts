/**
 * M-1: Bun one-shot with a real stdio MCP child must print an answer and exit.
 * Spawns `bun` so vitest (Node) still covers the Bun spawn path.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { TMP_BASE } from "./helpers/tmp_base.js";

const temp_dirs: string[] = [];
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

afterAll(async () => {
  for (const dir of temp_dirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function make_temp_dir(): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(path.join(TMP_BASE, "mcp-bun-oneshot-"));
  temp_dirs.push(dir);
  return dir;
}

function run_bun(script_path: string, cwd: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("bun", [script_path], { cwd, env: { ...process.env } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("close", (code) => {
      resolve({ code: code ?? 1, out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(err).toString("utf8") });
    });
  });
}

describe("M-1 bun stdio mcp one-shot", () => {
  it("returns an assistant answer when a stdio mcp server is enabled", async () => {
    const work_dir = await make_temp_dir();
    const server = path.join(work_dir, "mcp_server.mjs");
    await writeFile(
      server,
      [
        'import { createInterface } from "node:readline";',
        "const rl = createInterface({ input: process.stdin });",
        'rl.on("line", (line) => {',
        "  let msg;",
        "  try { msg = JSON.parse(line); } catch { return; }",
        '  if (msg.method === "notifications/initialized") return;',
        '  const result = msg.method === "initialize"',
        '    ? { protocolVersion: "2024-11-05", serverInfo: { name: "mock" } }',
        '    : msg.method === "tools/list"',
        '      ? { tools: [{ name: "ping", description: "ping", inputSchema: { type: "object" } }] }',
        '      : { content: [{ type: "text", text: "pong" }] };',
        '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");',
        "});",
        "",
      ].join("\n"),
    );
    const runner = path.join(work_dir, "run_oneshot.ts");
    await writeFile(
      runner,
      [
        'import path from "node:path";',
        `import { Agent } from ${JSON.stringify(path.join(REPO, "src/agent/agent.ts"))};`,
        `import { parse_agent_config } from ${JSON.stringify(path.join(REPO, "src/agent/config.ts"))};`,
        `const work_dir = ${JSON.stringify(work_dir)};`,
        "const fetch_fn = async () =>",
        "  new Response(",
        "    JSON.stringify({",
        '      model: "m",',
        '      choices: [{ message: { role: "assistant", content: "hello-from-oneshot" }, finish_reason: "stop" }],',
        "      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },",
        "    }),",
        "    { status: 200 },",
        "  );",
        "const agent = new Agent(",
        "  parse_agent_config({",
        '    providers: [{ kind: "openai_compat", name: "main", model: "m", base_url: "http://127.0.0.1:9", fetch_fn }],',
        "    work_dir,",
        '    session_dir: path.join(work_dir, "sessions"),',
        "    max_turns: 3,",
        '    log_level: "error",',
        '    tools_enabled: "all",',
        "    mcp_servers: {",
        `      lab: { enabled: true, command: process.execPath, args: [${JSON.stringify(server)}] },`,
        "    },",
        "  }),",
        "  [],",
        ");",
        'const result = await agent.run({ input: "hi" });',
        'const text = result.messages.filter((m) => m.role === "assistant").map((m) => m.content).join("|");',
        'console.log("ANSWER:" + text);',
        "agent.close();",
        "",
      ].join("\n"),
    );
    const ran = await run_bun(runner, work_dir);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain("ANSWER:hello-from-oneshot");
  }, 20000);
});
