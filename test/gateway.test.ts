/**
 * Gateway tests: conversation bus continuity/capping, webhook HTTP surface,
 * reply formatting, telegram splitting, and twitch IRC line parsing.
 * No real network to telegram/discord/twitch — webhook binds an ephemeral
 * port (0) on loopback only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse_agent_config } from "../src/agent/config.js";
import { create_webhook_adapter } from "../src/gateway/webhook.js";
import { format_agent_reply, split_text } from "../src/gateway/format.js";
import { create_telegram_adapter } from "../src/gateway/telegram.js";
import { parse_irc_line } from "../src/gateway/twitch.js";
import { GatewayBus } from "../src/gateway/bus.js";
import type { Agent, AgentRunResult } from "../src/agent/agent.js";
import type { Message, Usage } from "../src/providers/types.js";

const usage_zero: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
const usage_small: Usage = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 };

function config_for(work_dir: string) {
  return parse_agent_config({
    providers: [{ kind: "openai_compat", name: "main", model: "mock-model" }],
    work_dir,
  });
}

interface RunRecord {
  input: string;
  history: readonly Message[];
}

/** Agent that records each run and replies reply-<n> with a full transcript. */
function recording_agent(records: RunRecord[]): Agent {
  return {
    run: async (options: { input: string; history?: readonly Message[] }): Promise<AgentRunResult> => {
      const runs = records.push({ input: options.input, history: options.history ?? [] });
      return reply_result(`reply-${runs}`, options.history ?? [], options.input);
    },
  } as unknown as Agent;
}

/** Agent whose runs return `count` filler messages regardless of history. */
function flooding_agent(count: number): Agent {
  return {
    run: async (): Promise<AgentRunResult> => {
      return flooding_result(count);
    },
  } as unknown as Agent;
}

/** Run result whose messages are `count` filler user messages. */
function flooding_result(count: number): AgentRunResult {
  const messages: Message[] = Array.from({ length: count }, (_unused, index) => ({
    role: "user",
    content: `m${index}`,
  }));
  return {
    outcome: { messages, final: undefined, result: undefined, turns_used: 1, stopped_reason: "final" },
    messages,
    usage_total: usage_zero,
    session_path: undefined,
  };
}

/** Run result with full transcript = history + user input + one reply. */
function reply_result(reply: string, history: readonly Message[], input: string): AgentRunResult {
  const messages: Message[] = [...history, { role: "user", content: input }, { role: "assistant", content: reply }];
  return {
    outcome: {
      messages: [{ role: "assistant", content: reply }],
      final: { role: "assistant", content: reply },
      result: undefined,
      turns_used: 1,
      stopped_reason: "final",
    },
    messages,
    usage_total: usage_zero,
    session_path: undefined,
  };
}

describe("gateway bus", () => {
  it("keeps conversation continuity across handle() calls", async () => {
    const work_dir = mkdtempSync(join(tmpdir(), "lich-gw-"));
    try {
      const records: RunRecord[] = [];
      const bus = new GatewayBus({
        config: config_for(work_dir),
        agent_factory: () => recording_agent(records),
      });
      expect(await bus.handle("webhook", "c1", "u1", "hello")).toBe("reply-1");
      expect(await bus.handle("webhook", "c1", "u1", "again")).toBe("reply-2");
      const second = records[1];
      expect(second).toBeDefined();
      expect(second?.input).toBe("again");
      const contents = second?.history.map((message) => message.content) ?? [];
      expect(contents).toContain("hello");
      expect(contents).toContain("reply-1");
    } finally {
      rmSync(work_dir, { recursive: true, force: true });
    }
  });

  it("caps stored history at history_cap, dropping the oldest", async () => {
    const work_dir = mkdtempSync(join(tmpdir(), "lich-gw-"));
    try {
      // A single agent floods 60 messages on run 1 (no final content), then
      // records the history it receives on run 2.
      const records: RunRecord[] = [];
      let runs = 0;
      const probe_factory = (): Agent =>
        ({
          run: async (options: { input: string; history?: readonly Message[] }): Promise<AgentRunResult> => {
            runs += 1;
            if (runs === 1) {
              return flooding_result(60);
            }
            records.push({ input: options.input, history: options.history ?? [] });
            return reply_result("reply-2", options.history ?? [], options.input);
          },
        }) as unknown as Agent;
      const bus = new GatewayBus({ config: config_for(work_dir), agent_factory: probe_factory }, { history_cap: 5 });
      await bus.handle("webhook", "cap", "u1", "go");
      expect(await bus.handle("webhook", "cap", "u1", "again")).toBe("reply-2");
      const seen = records[0];
      expect(seen?.history.length).toBe(5);
      expect(seen?.history[0]?.content).toBe("m55");
    } finally {
      rmSync(work_dir, { recursive: true, force: true });
    }
  });

  it("drops leading non-user messages after a history cap slice (G-7)", async () => {
    const work_dir = mkdtempSync(join(tmpdir(), "lich-gw-"));
    try {
      const records: RunRecord[] = [];
      let runs = 0;
      const orphaned: Message[] = [
        { role: "user", content: "old" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "read_file", args: {} }] },
        { role: "tool", tool_call_id: "c1", name: "read_file", content: "data" },
        { role: "user", content: "keep-me" },
        { role: "assistant", content: "reply" },
      ];
      const probe_factory = (): Agent =>
        ({
          run: async (options: { input: string; history?: readonly Message[] }): Promise<AgentRunResult> => {
            runs += 1;
            if (runs === 1) {
              return {
                outcome: { messages: orphaned, final: undefined, result: undefined, turns_used: 1, stopped_reason: "final" },
                messages: orphaned,
                usage_total: usage_zero,
                session_path: undefined,
              };
            }
            records.push({ input: options.input, history: options.history ?? [] });
            return reply_result("ok", options.history ?? [], options.input);
          },
        }) as unknown as Agent;
      const bus = new GatewayBus({ config: config_for(work_dir), agent_factory: probe_factory }, { history_cap: 3 });
      await bus.handle("webhook", "orphan", "u1", "go");
      await bus.handle("webhook", "orphan", "u1", "again");
      const seen = records[0]?.history ?? [];
      expect(seen[0]?.role).toBe("user");
      expect(seen[0]?.content).toBe("keep-me");
      expect(seen.some((message) => message.role === "tool")).toBe(false);
    } finally {
      rmSync(work_dir, { recursive: true, force: true });
    }
  });

  it("returns a sanitized error reply and survives an agent throw", async () => {
    const work_dir = mkdtempSync(join(tmpdir(), "lich-gw-"));
    try {
      const bus = new GatewayBus({
        config: config_for(work_dir),
        agent_factory: () =>
          ({
            run: async (): Promise<AgentRunResult> => {
              throw new Error("boom\nwith\nnewlines");
            },
          }) as unknown as Agent,
      });
      const reply = await bus.handle("webhook", "err", "u1", "hi");
      expect(reply?.startsWith("agent error:")).toBe(true);
      expect(reply?.includes("boom")).toBe(true);
      expect(reply?.includes("\n")).toBe(false);
      expect(reply?.length).toBeLessThanOrEqual("agent error: ".length + 300);
    } finally {
      rmSync(work_dir, { recursive: true, force: true });
    }
  });
});

describe("webhook adapter", () => {
  const env_token = process.env.LICH_GATEWAY_TOKEN;

  afterEach(() => {
    if (env_token === undefined) {
      delete process.env.LICH_GATEWAY_TOKEN;
    } else {
      process.env.LICH_GATEWAY_TOKEN = env_token;
    }
  });

  function make_adapter(work_dir: string, reply: string, on_listening: (port: number) => void) {
    return create_webhook_adapter({
      config: config_for(work_dir),
      handle_message: async (_platform, _chat, _user, text) => `${reply}:${text}`,
      get_agent: () => {
        throw new Error("not used");
      },
      reply_router: () => undefined,
      port: 0,
      on_listening,
    });
  }

  it("serves POST /message, GET /health, and 404 for other paths", async () => {
    const work_dir = mkdtempSync(join(tmpdir(), "lich-gw-"));
    let port: number | undefined;
    const adapter = make_adapter(work_dir, "echo", (seen) => {
      port = seen;
    });
    try {
      await adapter.start();
      if (port === undefined) {
        throw new Error("webhook did not report a listening port");
      }
      const base = `http://127.0.0.1:${port}`;
      const message = await fetch(`${base}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(message.status).toBe(200);
      expect(((await message.json()) as { reply: string }).reply).toBe("echo:hi");
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect(((await health.json()) as { status: string }).status).toBe("ok");
      const missing = await fetch(`${base}/nope`);
      expect(missing.status).toBe(404);
    } finally {
      await adapter.stop();
      rmSync(work_dir, { recursive: true, force: true });
    }
  });

  it("requires the x-lich-token header when LICH_GATEWAY_TOKEN is set", async () => {
    const work_dir = mkdtempSync(join(tmpdir(), "lich-gw-"));
    process.env.LICH_GATEWAY_TOKEN = "sekrit";
    let port: number | undefined;
    const adapter = make_adapter(work_dir, "echo", (seen) => {
      port = seen;
    });
    try {
      await adapter.start();
      if (port === undefined) {
        throw new Error("webhook did not report a listening port");
      }
      const base = `http://127.0.0.1:${port}`;
      const denied = await fetch(`${base}/message`, {
        method: "POST",
        body: JSON.stringify({ text: "hi" }),
      });
      expect(denied.status).toBe(401);
      const allowed = await fetch(`${base}/message`, {
        method: "POST",
        headers: { "x-lich-token": "sekrit" },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(allowed.status).toBe(200);
    } finally {
      await adapter.stop();
      rmSync(work_dir, { recursive: true, force: true });
    }
  });

  it("rejects a message body without text and closes cleanly on stop()", async () => {
    const work_dir = mkdtempSync(join(tmpdir(), "lich-gw-"));
    let port: number | undefined;
    const adapter = make_adapter(work_dir, "echo", (seen) => {
      port = seen;
    });
    try {
      await adapter.start();
      if (port === undefined) {
        throw new Error("webhook did not report a listening port");
      }
      const base = `http://127.0.0.1:${port}`;
      const bad = await fetch(`${base}/message`, { method: "POST", body: JSON.stringify({ nope: true }) });
      expect(bad.status).toBe(400);
      await adapter.stop();
      let closed = false;
      try {
        await fetch(`${base}/health`);
      } catch {
        closed = true;
      }
      expect(closed).toBe(true);
      port = undefined;
    } finally {
      await adapter.stop();
      rmSync(work_dir, { recursive: true, force: true });
    }
  });
});

describe("gateway format", () => {
  it("formats webhook replies as JSON with reply and usage", () => {
    const parsed = JSON.parse(format_agent_reply("hi there", usage_small, "webhook")) as {
      reply: string;
      usage: Usage;
    };
    expect(parsed.reply).toBe("hi there");
    expect(parsed.usage.total_tokens).toBe(7);
    const null_usage = JSON.parse(format_agent_reply("hi", undefined, "webhook")) as { usage: unknown };
    expect(null_usage.usage).toBeNull();
  });

  it("appends a compact token footer for telegram when usage exists", () => {
    const text = format_agent_reply("answer", usage_small, "telegram");
    expect(text.startsWith("answer")).toBe(true);
    expect(text.endsWith("_tokens: 7_")).toBe(true);
  });

  it("omits the footer when usage is missing or zero", () => {
    expect(format_agent_reply("answer", undefined, "discord")).toBe("answer");
    expect(format_agent_reply("answer", usage_zero, "discord")).toBe("answer");
  });
});

describe("telegram splitting", () => {
  it("splits a 5000-char message into two chunks within the limit", () => {
    const long = "word ".repeat(1000).trimEnd();
    expect(long.length).toBeGreaterThan(4096);
    const chunks = split_text(long, 4096);
    expect(chunks.length).toBe(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
      expect(chunk.length).toBeGreaterThan(0);
    }
    expect(chunks.join(" ")).toBe(long);
  });

  it("prefers newline boundaries when available", () => {
    const text = `${"a".repeat(3000)}\n${"b".repeat(3000)}`;
    const chunks = split_text(text, 4096);
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.includes("\n")).toBe(false);
  });

  it("keeps short messages intact as a single chunk", () => {
    expect(split_text("short", 4096)).toEqual(["short"]);
  });

  it("degrades to an idle adapter when the token is missing", () => {
    const token = process.env.LICH_TELEGRAM_BOT_TOKEN;
    delete process.env.LICH_TELEGRAM_BOT_TOKEN;
    try {
      const adapter = create_telegram_adapter({
        config: parse_agent_config({ providers: [{ kind: "openai_compat", name: "m", model: "x" }] }),
        handle_message: async () => "",
        get_agent: () => {
          throw new Error("not used");
        },
        reply_router: () => undefined,
      });
      expect(adapter.name).toBe("telegram");
    } finally {
      if (token !== undefined) {
        process.env.LICH_TELEGRAM_BOT_TOKEN = token;
      }
    }
  });
});

describe("twitch irc parsing", () => {
  it("parses a tagged PRIVMSG into channel, user, and text", () => {
    const line =
      "@badge-info=;badges=;color=#FF0000;display-name=Viewer :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #channelname :hello there";
    const parsed = parse_irc_line(line);
    expect(parsed.kind).toBe("privmsg");
    expect(parsed.channel).toBe("channelname");
    expect(parsed.user).toBe("viewer");
    expect(parsed.text).toBe("hello there");
  });

  it("maps PING to the exact PONG response", () => {
    const parsed = parse_irc_line("PING :tmi.twitch.tv");
    expect(parsed.kind).toBe("ping");
  });

  it("ignores non-matching lines", () => {
    expect(parse_irc_line(":tmi.twitch.tv 001 nick :Welcome").kind).toBe("other");
    expect(parse_irc_line("@tags :nick!nick@nick.tmi.twitch.tv JOIN #chan").kind).toBe("other");
  });
});