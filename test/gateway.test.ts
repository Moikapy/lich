/**
 * Gateway tests: conversation bus continuity/capping, webhook HTTP surface,
 * reply formatting, telegram splitting, and twitch IRC line parsing.
 * No real network to telegram/discord/twitch — webhook binds an ephemeral
 * port (0) on loopback only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parse_agent_config } from "../src/agent/config.js";
import {
  create_gateway_policy,
  DEFAULT_GATEWAY_TOOLS_ENABLED,
  gateway_tools_enabled,
  is_gateway_sender_allowed,
  type GatewayPolicy,
} from "../src/gateway/access.js";
import { create_discord_adapter } from "../src/gateway/discord.js";
import { create_twitch_adapter } from "../src/gateway/twitch.js";
import { logger } from "../src/util/log.js";
import { assert_bind_allowed, create_webhook_adapter, MAX_WEBHOOK_BODY_BYTES } from "../src/gateway/webhook.js";
import { format_agent_reply, split_text } from "../src/gateway/format.js";
import { create_telegram_adapter } from "../src/gateway/telegram.js";
import { parse_irc_line, sanitize_twitch_outbound, TWITCH_MESSAGE_CAP } from "../src/gateway/twitch.js";
import { note_partial_messages } from "../src/agent/loop.js";
import { GatewayBus } from "../src/gateway/bus.js";
import type { Agent, AgentRunResult } from "../src/agent/agent.js";
import type { Message, Usage } from "../src/providers/types.js";
import type { GatewayReply } from "../src/gateway/types.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const usage_zero: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
const usage_small: Usage = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 };

function config_for(work_dir: string, gateway?: Record<string, unknown>) {
  return parse_agent_config({
    providers: [{ kind: "openai_compat", name: "main", model: "mock-model" }],
    work_dir,
    ...(gateway === undefined ? {} : { gateway }),
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

function temp_work_dir(): string {
  mkdirSync(TMP_BASE, { recursive: true });
  return mkdtempSync(join(TMP_BASE, "lich-gw-"));
}

/** Second handle() sees whatever cap_history stored from the first run's messages. */
async function capped_followup_history(
  work_dir: string,
  first_messages: Message[],
  history_cap: number,
): Promise<readonly Message[]> {
  const records: RunRecord[] = [];
  let runs = 0;
  const probe_factory = (): Agent =>
    ({
      run: async (options: { input: string; history?: readonly Message[] }): Promise<AgentRunResult> => {
        runs += 1;
        if (runs === 1) {
          return {
            outcome: {
              messages: first_messages,
              final: undefined,
              result: undefined,
              turns_used: 1,
              stopped_reason: "final",
            },
            messages: first_messages,
            usage_total: usage_zero,
            session_path: undefined,
          };
        }
        records.push({ input: options.input, history: options.history ?? [] });
        return reply_result("ok", options.history ?? [], options.input);
      },
    }) as unknown as Agent;
  const bus = new GatewayBus({ config: config_for(work_dir), agent_factory: probe_factory }, { history_cap });
  await bus.handle("webhook", "cap-edge", "u1", "go");
  await bus.handle("webhook", "cap-edge", "u1", "again");
  return records[0]?.history ?? [];
}

describe("gateway bus", () => {
  it("keeps conversation continuity across handle() calls", async () => {
    const work_dir = temp_work_dir();
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
    const work_dir = temp_work_dir();
    try {
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
    const work_dir = temp_work_dir();
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

  it("starts the capped history at a user when the window opens on an assistant reply", async () => {
    const work_dir = temp_work_dir();
    try {
      const records: RunRecord[] = [];
      let runs = 0;
      const plain: Message[] = [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
        { role: "assistant", content: "a2" },
      ];
      const probe_factory = (): Agent =>
        ({
          run: async (options: { input: string; history?: readonly Message[] }): Promise<AgentRunResult> => {
            runs += 1;
            if (runs === 1) {
              return {
                outcome: { messages: plain, final: undefined, result: undefined, turns_used: 1, stopped_reason: "final" },
                messages: plain,
                usage_total: usage_zero,
                session_path: undefined,
              };
            }
            records.push({ input: options.input, history: options.history ?? [] });
            return reply_result("ok", options.history ?? [], options.input);
          },
        }) as unknown as Agent;
      const bus = new GatewayBus({ config: config_for(work_dir), agent_factory: probe_factory }, { history_cap: 3 });
      await bus.handle("webhook", "plain", "u1", "go");
      await bus.handle("webhook", "plain", "u1", "again");
      const seen = records[0]?.history ?? [];
      expect(seen.map((message) => message.content)).toEqual(["u2", "a2"]);
    } finally {
      rmSync(work_dir, { recursive: true, force: true });
    }
  });

  it("keeps a tool-heavy turn when the cap window contains no user message", async () => {
    const work_dir = temp_work_dir();
    try {
      const records: RunRecord[] = [];
      const heavy: Message[] = [{ role: "user", content: "search the repo" }];
      for (let index = 0; index < 6; index += 1) {
        heavy.push({
          role: "assistant",
          content: "",
          tool_calls: [{ id: `c${index}`, name: "grep_files", args: {} }],
        });
        heavy.push({
          role: "tool",
          tool_call_id: `c${index}`,
          name: "grep_files",
          content: `hit-${index}`,
        });
      }
      let runs = 0;
      const probe_factory = (): Agent =>
        ({
          run: async (options: { input: string; history?: readonly Message[] }): Promise<AgentRunResult> => {
            runs += 1;
            if (runs === 1) {
              return {
                outcome: { messages: heavy, final: undefined, result: undefined, turns_used: 6, stopped_reason: "final" },
                messages: heavy,
                usage_total: usage_zero,
                session_path: undefined,
              };
            }
            records.push({ input: options.input, history: options.history ?? [] });
            return reply_result("ok", options.history ?? [], options.input);
          },
        }) as unknown as Agent;
      const bus = new GatewayBus({ config: config_for(work_dir), agent_factory: probe_factory }, { history_cap: 4 });
      await bus.handle("webhook", "heavy", "u1", "go");
      await bus.handle("webhook", "heavy", "u1", "what did you find?");
      const seen = records[0]?.history ?? [];
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]).toEqual({ role: "user", content: "(earlier conversation trimmed)" });
      expect(seen[1]?.role).toBe("assistant");
      expect(seen.some((message) => message.role === "tool" && message.content === "hit-5")).toBe(true);
      expect(seen.filter((message) => message.role === "user")).toHaveLength(1);
    } finally {
      rmSync(work_dir, { recursive: true, force: true });
    }
  });

  it("keeps the assistant when the cap window is only its tool results", async () => {
    const work_dir = temp_work_dir();
    try {
      const records: RunRecord[] = [];
      const batch: Message[] = [
        { role: "user", content: "read both" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "c1", name: "read_file", args: {} },
            { id: "c2", name: "read_file", args: {} },
          ],
        },
        { role: "tool", tool_call_id: "c1", name: "read_file", content: "one" },
        { role: "tool", tool_call_id: "c2", name: "read_file", content: "two" },
      ];
      let runs = 0;
      const probe_factory = (): Agent =>
        ({
          run: async (options: { input: string; history?: readonly Message[] }): Promise<AgentRunResult> => {
            runs += 1;
            if (runs === 1) {
              return {
                outcome: { messages: batch, final: undefined, result: undefined, turns_used: 1, stopped_reason: "final" },
                messages: batch,
                usage_total: usage_zero,
                session_path: undefined,
              };
            }
            records.push({ input: options.input, history: options.history ?? [] });
            return reply_result("ok", options.history ?? [], options.input);
          },
        }) as unknown as Agent;
      const bus = new GatewayBus({ config: config_for(work_dir), agent_factory: probe_factory }, { history_cap: 2 });
      await bus.handle("webhook", "batch", "u1", "go");
      await bus.handle("webhook", "batch", "u1", "again");
      const seen = records[0]?.history ?? [];
      expect(seen.map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool"]);
      expect(seen[2]?.content).toBe("one");
      expect(seen[3]?.content).toBe("two");
    } finally {
      rmSync(work_dir, { recursive: true, force: true });
    }
  });

  it("drops a leading tool fragment and keeps the next assistant when the cap has no user", async () => {
    const work_dir = temp_work_dir();
    try {
      const transcript: Message[] = [
        { role: "user", content: "u1" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "read_file", args: {} }] },
        { role: "tool", tool_call_id: "c1", name: "read_file", content: "stale" },
        { role: "assistant", content: "", tool_calls: [{ id: "c2", name: "read_file", args: {} }] },
        { role: "tool", tool_call_id: "c2", name: "read_file", content: "fresh" },
      ];
      const seen = await capped_followup_history(work_dir, transcript, 3);
      expect(seen.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
      expect(seen[0]).toEqual({ role: "user", content: "(earlier conversation trimmed)" });
      expect(seen[2]?.content).toBe("fresh");
      expect(seen.some((message) => message.content === "stale")).toBe(false);
    } finally {
      rmSync(work_dir, { recursive: true, force: true });
    }
  });

  it("stores no history when a capped tool window has no owning assistant", async () => {
    const work_dir = temp_work_dir();
    try {
      const from_user: Message[] = [
        { role: "user", content: "u1" },
        { role: "tool", tool_call_id: "c1", name: "read_file", content: "orphan" },
        { role: "tool", tool_call_id: "c2", name: "read_file", content: "orphan-2" },
      ];
      expect(await capped_followup_history(work_dir, from_user, 2)).toEqual([]);
      const empty_calls: Message[] = [
        { role: "user", content: "u1" },
        { role: "assistant", content: "no calls", tool_calls: [] },
        { role: "tool", tool_call_id: "c1", name: "read_file", content: "orphan" },
        { role: "tool", tool_call_id: "c2", name: "read_file", content: "orphan-2" },
      ];
      expect(await capped_followup_history(work_dir, empty_calls, 2)).toEqual([]);
    } finally {
      rmSync(work_dir, { recursive: true, force: true });
    }
  });

  it("releases settled session queues so they stay bounded (G-6)", async () => {
    const work_dir = temp_work_dir();
    try {
      const bus = new GatewayBus({
        config: config_for(work_dir),
        agent_factory: () => recording_agent([]),
      });
      await bus.handle("webhook", "c1", "u1", "one");
      await bus.handle("webhook", "c2", "u1", "two");
      const sessions = (bus as unknown as { sessions: { pending_count(): number } }).sessions;
      expect(sessions.pending_count()).toBe(0);
    } finally {
      rmSync(work_dir, { recursive: true, force: true });
    }
  });

  it("returns a sanitized error reply and survives an agent throw", async () => {
    const work_dir = temp_work_dir();
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

  it("evicts the least recently used conversation, not the oldest inserted (G-10)", async () => {
    const work_dir = temp_work_dir();
    try {
      const records: RunRecord[] = [];
      const bus = new GatewayBus(
        { config: config_for(work_dir), agent_factory: () => recording_agent(records) },
        { max_conversations: 2 },
      );
      await bus.handle("webhook", "a", "u1", "a1");
      await bus.handle("webhook", "b", "u1", "b1");
      await bus.handle("webhook", "a", "u1", "a2");
      await bus.handle("webhook", "c", "u1", "c1");
      await bus.handle("webhook", "a", "u1", "a3");
      await bus.handle("webhook", "b", "u1", "b2");
      const history_of = (input: string): readonly Message[] => records.find((run) => run.input === input)?.history ?? [];
      // a was used after b, so c evicted b: a keeps its history and b starts over.
      expect(history_of("a3").length).toBeGreaterThan(0);
      expect(history_of("b2")).toEqual([]);
    } finally {
      rmSync(work_dir, { recursive: true, force: true });
    }
  });

  it("rewrites only telegram's /start command to hello (G-10)", async () => {
    const work_dir = temp_work_dir();
    try {
      const records: RunRecord[] = [];
      const bus = new GatewayBus({
        config: config_for(work_dir, { allowed_users: { telegram: ["u1"], discord: ["u1"] } }),
        agent_factory: () => recording_agent(records),
      });
      await bus.handle("telegram", "t1", "u1", "/start");
      await bus.handle("telegram", "t2", "u1", "/start@lich_bot deep-link");
      await bus.handle("telegram", "t3", "u1", "/started a thing");
      await bus.handle("webhook", "w1", "u1", "/start");
      await bus.handle("telegram", "t4", "u1", "/start@lich_bot");
      await bus.handle("telegram", "t5", "u1", "/start/foo");
      await bus.handle("telegram", "t6", "u1", "/start@");
      await bus.handle("discord", "d1", "u1", "/start");
      expect(records.map((run) => run.input)).toEqual([
        "hello",
        "hello",
        "/started a thing",
        "/start",
        "hello",
        "/start/foo",
        "/start@",
        "/start",
      ]);
    } finally {
      rmSync(work_dir, { recursive: true, force: true });
    }
  });

  it("reply() carries the run's usage, and marks agent failures", async () => {
    const work_dir = temp_work_dir();
    try {
      let fail = false;
      const bus = new GatewayBus({
        config: config_for(work_dir),
        agent_factory: () =>
          ({
            run: async (options: { input: string; history?: readonly Message[] }): Promise<AgentRunResult> => {
              if (fail === true) {
                throw new Error("provider down");
              }
              return { ...reply_result("ok", options.history ?? [], options.input), usage_total: usage_small };
            },
          }) as unknown as Agent,
      });
      expect(await bus.reply("webhook", "c1", "u1", "hi")).toEqual({ text: "ok", usage: usage_small });
      fail = true;
      const failed = await bus.reply("webhook", "c1", "u1", "again");
      expect(failed?.failed).toBe(true);
      expect(failed?.text.startsWith("agent error: provider down")).toBe(true);
      expect(failed?.usage).toBeUndefined();
    } finally {
      rmSync(work_dir, { recursive: true, force: true });
    }
  });

  it("handle() omits an empty final reply; reply() still returns the empty text", async () => {
    const work_dir = temp_work_dir();
    try {
      const bus = new GatewayBus({
        config: config_for(work_dir),
        agent_factory: () =>
          ({
            run: async (): Promise<AgentRunResult> => ({
              outcome: {
                messages: [],
                final: { role: "assistant", content: "" },
                result: undefined,
                turns_used: 1,
                stopped_reason: "final",
              },
              messages: [],
              usage_total: usage_small,
              session_path: undefined,
            }),
          }) as unknown as Agent,
      });
      expect(await bus.handle("webhook", "c1", "u1", "hi")).toBeUndefined();
      expect(await bus.reply("webhook", "c1", "u1", "hi")).toEqual({ text: "", usage: usage_small });
    } finally {
      rmSync(work_dir, { recursive: true, force: true });
    }
  });

  it("keeps completed tool turns when a later model call throws", async () => {
    const work_dir = temp_work_dir();
    try {
      const records: RunRecord[] = [];
      const partial: Message[] = [
        { role: "user", content: "go" },
        { role: "assistant", content: "", tool_calls: [{ id: "t1", name: "read_file", args: { path: "a.txt" } }] },
        { role: "tool", tool_call_id: "t1", name: "read_file", content: "file-body" },
      ];
      let thrown = false;
      const bus = new GatewayBus({
        config: config_for(work_dir),
        agent_factory: () =>
          ({
            run: async (options: { input: string; history?: readonly Message[] }): Promise<AgentRunResult> => {
              records.push({ input: options.input, history: options.history ?? [] });
              if (thrown === false) {
                thrown = true;
                throw note_partial_messages(new Error("provider down"), partial);
              }
              return reply_result("ok", options.history ?? [], options.input);
            },
          }) as unknown as Agent,
      });
      const reply = await bus.handle("webhook", "err", "u1", "go");
      expect(reply?.includes("provider down")).toBe(true);
      expect(await bus.handle("webhook", "err", "u1", "again")).toBe("ok");
      expect(records[1]?.history.some((message) => message.role === "tool" && message.content === "file-body")).toBe(
        true,
      );
    } finally {
      rmSync(work_dir, { recursive: true, force: true });
    }
  });

  it("default-denies public platforms until allowlists are set", async () => {
    const work_dir = temp_work_dir();
    try {
      const records: RunRecord[] = [];
      const denied = new GatewayBus({
        config: config_for(work_dir, {}),
        agent_factory: () => recording_agent(records),
      });
      expect(await denied.handle("telegram", "chat-1", "user-1", "hi")).toBeUndefined();
      expect(records).toHaveLength(0);

      const allowed = new GatewayBus({
        config: config_for(work_dir, { allowed_users: { telegram: ["user-1"] } }),
        agent_factory: () => recording_agent(records),
      });
      expect(await allowed.handle("telegram", "chat-1", "user-1", "hi")).toBe("reply-1");
      expect(await allowed.handle("telegram", "chat-1", "other", "nope")).toBeUndefined();
      expect(records).toHaveLength(1);
    } finally {
      rmSync(work_dir, { recursive: true, force: true });
    }
  });

  it("requires both user and chat when both public allowlists are set", async () => {
    const work_dir = temp_work_dir();
    try {
      const records: RunRecord[] = [];
      const bus = new GatewayBus({
        config: config_for(work_dir, {
          allowed_users: {
            discord: ["user-1"],
            twitch: ["user-1"],
            telegram: ["user-1"],
          },
          allowed_chats: {
            discord: ["chat-1"],
            twitch: ["chat-1"],
            telegram: ["chat-1"],
          },
        }),
        agent_factory: () => recording_agent(records),
      });
      expect(await bus.handle("discord", "chat-1", "user-1", "hi")).toBe("reply-1");
      expect(await bus.handle("discord", "chat-1", "user-2", "nope")).toBeUndefined();
      expect(await bus.handle("discord", "chat-2", "user-1", "nope")).toBeUndefined();
      expect(await bus.handle("twitch", "chat-9", "user-1", "nope")).toBeUndefined();
      expect(await bus.handle("telegram", "chat-1", "stranger", "nope")).toBeUndefined();
      expect(await bus.handle("webhook", "anywhere", "anyone", "hi")).toBe("reply-2");
      expect(records.map((record) => record.input)).toEqual(["hi", "hi"]);
    } finally {
      rmSync(work_dir, { recursive: true, force: true });
    }
  });
});

describe("gateway access", () => {
  it("allows webhook without allowlists and requires lists on public platforms", () => {
    const work_dir = temp_work_dir();
    try {
      const bare = config_for(work_dir);
      expect(is_gateway_sender_allowed(bare, "webhook", "c", "u")).toBe(true);
      expect(is_gateway_sender_allowed(bare, "discord", "c", "u")).toBe(false);
      const with_chat = config_for(work_dir, { allowed_chats: { discord: ["c"] } });
      expect(is_gateway_sender_allowed(with_chat, "discord", "c", "anyone")).toBe(true);
      expect(is_gateway_sender_allowed(with_chat, "discord", "other", "anyone")).toBe(false);
    } finally {
      rmSync(work_dir, { recursive: true, force: true });
    }
  });

  it("defaults gateway tools to the safe read-only subset", () => {
    const work_dir = temp_work_dir();
    try {
      expect(gateway_tools_enabled(config_for(work_dir))).toEqual([...DEFAULT_GATEWAY_TOOLS_ENABLED]);
      expect(DEFAULT_GATEWAY_TOOLS_ENABLED.includes("terminal")).toBe(false);
      expect(DEFAULT_GATEWAY_TOOLS_ENABLED.includes("write_file")).toBe(false);
      const open = config_for(work_dir, { tools_enabled: "all" });
      expect(gateway_tools_enabled(open)).toBe("all");
      expect(open.gateway?.tools_enabled).toBe("all");
    } finally {
      rmSync(work_dir, { recursive: true, force: true });
    }
  });

  it("builds one GatewayPolicy from config: toolset plus the sender allowlists", () => {
    const work_dir = temp_work_dir();
    try {
      const policy = create_gateway_policy(config_for(work_dir, { allowed_users: { discord: ["u1"] } }));
      expect(policy.tools_enabled).toEqual([...DEFAULT_GATEWAY_TOOLS_ENABLED]);
      expect(policy.allows("webhook", "c", "anyone")).toBe(true);
      expect(policy.allows("discord", "c", "u1")).toBe(true);
      expect(policy.allows("discord", "c", "u2")).toBe(false);
      expect(policy.allows("telegram", "c", "u1")).toBe(false);
    } finally {
      rmSync(work_dir, { recursive: true, force: true });
    }
  });

  it("lets the bus use an injected policy instead of the config's", async () => {
    const work_dir = temp_work_dir();
    try {
      const records: RunRecord[] = [];
      const deny_all: GatewayPolicy = { tools_enabled: [], allows: () => false };
      const bus = new GatewayBus({ config: config_for(work_dir), policy: deny_all, agent_factory: () => recording_agent(records) });
      expect(await bus.handle("webhook", "c1", "u1", "hello")).toBeUndefined();
      expect(records).toEqual([]);
    } finally {
      rmSync(work_dir, { recursive: true, force: true });
    }
  });
});

describe("adapter capabilities", () => {
  it("declares each platform's reply cap, also on idle adapters", () => {
    const saved = { ...process.env };
    for (const key of ["LICH_TELEGRAM_BOT_TOKEN", "LICH_DISCORD_BOT_TOKEN", "LICH_TWITCH_OAUTH_TOKEN", "LICH_TWITCH_NICK"]) {
      delete process.env[key];
    }
    const params = {
      config: parse_agent_config({ providers: [{ kind: "openai_compat", name: "m", model: "x" }] }),
      handle_message: async () => "",
      get_agent: (): Agent => {
        throw new Error("not used");
      },
      reply_router: () => undefined,
    };
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      expect(create_telegram_adapter(params).capabilities).toEqual({ kind: "text", max_reply_chars: 4096 });
      expect(create_discord_adapter(params).capabilities).toEqual({ kind: "text", max_reply_chars: 2000 });
      expect(create_twitch_adapter(params).capabilities).toEqual({ kind: "text", max_reply_chars: TWITCH_MESSAGE_CAP });
      expect(create_webhook_adapter({ ...params, port: 0, host: "127.0.0.1" }).capabilities).toEqual({ kind: "text" });
    } finally {
      vi.restoreAllMocks();
      process.env = saved;
    }
  });
});

describe("webhook adapter", () => {
  const env_token = process.env.LICH_GATEWAY_TOKEN;
  const env_host = process.env.LICH_GATEWAY_HOST;

  afterEach(() => {
    if (env_token === undefined) {
      delete process.env.LICH_GATEWAY_TOKEN;
    } else {
      process.env.LICH_GATEWAY_TOKEN = env_token;
    }
    if (env_host === undefined) {
      delete process.env.LICH_GATEWAY_HOST;
    } else {
      process.env.LICH_GATEWAY_HOST = env_host;
    }
  });

  function make_adapter(
    work_dir: string,
    reply: string,
    on_listening: (port: number) => void,
    handle?: (
      platform: string,
      chat_id: string,
      user_id: string,
      text: string,
    ) => Promise<string | GatewayReply | undefined>,
  ) {
    return create_webhook_adapter({
      config: config_for(work_dir),
      handle_message:
        handle ??
        (async (_platform, _chat, _user, text) => `${reply}:${text}`),
      get_agent: () => {
        throw new Error("not used");
      },
      reply_router: () => undefined,
      port: 0,
      host: "127.0.0.1",
      on_listening,
    });
  }

  it("stops promptly while a keep-alive client is still connected", async () => {
    const work_dir = temp_work_dir();
    let port: number | undefined;
    const adapter = make_adapter(work_dir, "echo", (seen) => {
      port = seen;
    });
    try {
      await adapter.start();
      const { request } = await import("node:http");
      const agent = new (await import("node:http")).Agent({ keepAlive: true });
      await new Promise<void>((resolve, reject) => {
        const req = request(
          { host: "127.0.0.1", port, path: "/health", agent },
          (response) => {
            response.resume();
            response.on("end", () => resolve());
          },
        );
        req.on("error", reject);
        req.end();
      });
      const started = Date.now();
      await adapter.stop();
      expect(Date.now() - started).toBeLessThan(1000);
      agent.destroy();
    } finally {
      rmSync(work_dir, { recursive: true, force: true });
    }
  });

  it("returns the run's usage, and HTTP 502 with the error when the agent fails", async () => {
    const work_dir = temp_work_dir();
    let port: number | undefined;
    const adapter = make_adapter(
      work_dir,
      "unused",
      (seen) => {
        port = seen;
      },
      async (_platform, _chat, _user, text) =>
        text === "fail" ? { text: "agent error: provider down", failed: true } : { text: `ok:${text}`, usage: usage_small },
    );
    try {
      await adapter.start();
      const post = (text: string) =>
        fetch(`http://127.0.0.1:${String(port)}/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
      const ok = await post("hi");
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ reply: "ok:hi", usage: usage_small });
      const failed = await post("fail");
      expect(failed.status).toBe(502);
      expect(await failed.json()).toEqual({ error: "agent error: provider down" });
    } finally {
      await adapter.stop();
      rmSync(work_dir, { recursive: true, force: true });
    }
  });

  it("serves POST /message, GET /health, and 404 for other paths", async () => {
    const work_dir = temp_work_dir();
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
    const work_dir = temp_work_dir();
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
    const work_dir = temp_work_dir();
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

  it("forces platform=webhook even when the body claims another platform", async () => {
    const work_dir = temp_work_dir();
    let port: number | undefined;
    const seen: string[] = [];
    const adapter = make_adapter(work_dir, "echo", (bound) => {
      port = bound;
    }, async (platform, chat_id, user_id, text) => {
      seen.push(`${platform}:${chat_id}:${user_id}:${text}`);
      return "ok";
    });
    try {
      await adapter.start();
      if (port === undefined) {
        throw new Error("webhook did not report a listening port");
      }
      const response = await fetch(`http://127.0.0.1:${port}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          platform: "telegram",
          chat_id: "stolen",
          user_id: "attacker",
          text: "leak",
        }),
      });
      expect(response.status).toBe(200);
      expect(seen).toEqual(["webhook:stolen:attacker:leak"]);
    } finally {
      await adapter.stop();
      rmSync(work_dir, { recursive: true, force: true });
    }
  });

  it("rejects oversized POST bodies with 413 (G-6)", async () => {
    const work_dir = temp_work_dir();
    let port: number | undefined;
    const adapter = make_adapter(work_dir, "echo", (seen) => {
      port = seen;
    });
    try {
      await adapter.start();
      if (port === undefined) {
        throw new Error("webhook did not report a listening port");
      }
      const oversized = "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1);
      const response = await fetch(`http://127.0.0.1:${port}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: oversized,
      });
      expect(response.status).toBe(413);
    } finally {
      await adapter.stop();
      rmSync(work_dir, { recursive: true, force: true });
    }
  });

  it("refuses a non-loopback bind when no token is set", () => {
    expect(() => assert_bind_allowed("0.0.0.0", undefined)).toThrow(/refuses non-loopback/);
    expect(() => assert_bind_allowed("0.0.0.0", "")).toThrow(/refuses non-loopback/);
    expect(() => assert_bind_allowed("127.0.0.1", undefined)).not.toThrow();
    expect(() => assert_bind_allowed("0.0.0.0", "sekrit")).not.toThrow();
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

  it("recognizes IRC welcome and ignores other noise", () => {
    expect(parse_irc_line(":tmi.twitch.tv 001 nick :Welcome").kind).toBe("welcome");
    expect(parse_irc_line("@tags :nick!nick@nick.tmi.twitch.tv JOIN #chan").kind).toBe("other");
  });

  it("rejects USERNOTICE/WHISPER spoof lines that embed PRIVMSG", () => {
    const usernotice =
      "@msg-id=raid :tmi.twitch.tv USERNOTICE #chan :hi x!owner@o PRIVMSG #chan :pwned";
    expect(parse_irc_line(usernotice).kind).toBe("other");
    const whisper = ":evil!evil@evil.tmi.twitch.tv WHISPER victim :x!owner@o PRIVMSG #chan :pwned";
    expect(parse_irc_line(whisper).kind).toBe("other");
  });

  it("sanitizes outbound IRC control chars and chat-command prefixes (G-8)", () => {
    expect(sanitize_twitch_outbound("hello\r\nPRIVMSG #x :pwn")).toBe("hello PRIVMSG #x :pwn");
    expect(sanitize_twitch_outbound("/me waves")).toBe("me waves");
    expect(sanitize_twitch_outbound(".timeout someone")).toBe("timeout someone");
    expect(TWITCH_MESSAGE_CAP).toBeLessThanOrEqual(450);
  });
});
