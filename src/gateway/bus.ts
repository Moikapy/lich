/**
 * GatewayBus: conversation-keyed runner over one shared Agent.
 *
 * Per-conversation history lives in a bounded Map evicted by least recent
 * use; messages for the same conversation are serialized on the shared
 * SessionManager so history never interleaves. Agent failures become
 * sanitized reply strings.
 */
import type { Agent } from "../agent/agent.js";
import type { AgentConfig } from "../agent/config.js";
import { history_after_run_error } from "../agent/loop.js";
import type { Message } from "../providers/types.js";
import { create_session_manager, type SessionManager } from "../session/manager.js";
import { logger } from "../util/log.js";
import { check_gateway_sender } from "./access.js";
import { sanitize_agent_error, type GatewayReply } from "./types.js";

export interface GatewayBusOptions {
  history_cap?: number;
  max_conversations?: number;
}

export interface BusParams {
  config: AgentConfig;
  agent_factory: () => Agent;
  /** Subscribe to agent tool events for debug logging (creates the agent). */
  wire_tool_logging?: boolean;
}

const DEFAULT_HISTORY_CAP = 40;
const DEFAULT_MAX_CONVERSATIONS = 200;

export class GatewayBus {
  private readonly config: AgentConfig;
  private readonly agent_factory: () => Agent;
  private agent: Agent | undefined;
  private readonly histories: Map<string, Message[]> = new Map();
  private readonly sessions: SessionManager = create_session_manager();
  private readonly history_cap: number;
  private readonly max_conversations: number;
  private stop_logging: (() => void) | undefined;

  constructor(params: BusParams, options?: GatewayBusOptions) {
    this.config = params.config;
    this.agent_factory = params.agent_factory;
    this.history_cap = options?.history_cap ?? DEFAULT_HISTORY_CAP;
    this.max_conversations = options?.max_conversations ?? DEFAULT_MAX_CONVERSATIONS;
    if (params.wire_tool_logging === true) {
      this.wire_tool_logging();
    }
  }

  /** Serializes runs per conversation and resolves to the reply text (undefined when empty or denied). */
  async handle(platform: string, chat_id: string, user_id: string, text: string): Promise<string | undefined> {
    const reply = await this.reply(platform, chat_id, user_id, text);
    return reply === undefined || reply.text.length === 0 ? undefined : reply.text;
  }

  /** Like `handle`, with the run's usage and whether it failed; undefined when the sender is denied. */
  async reply(platform: string, chat_id: string, user_id: string, text: string): Promise<GatewayReply | undefined> {
    if (check_gateway_sender(this.config, platform, chat_id, user_id) === false) {
      return undefined;
    }
    const key = conversation_key(platform, chat_id);
    return this.sessions.enqueue(key, () => this.run_once(key, platform, chat_id, user_id, text));
  }

  /** Unsubscribes the debug tool logger (bus owns no other resources). */
  stop(): void {
    this.stop_logging?.();
    this.stop_logging = undefined;
  }

  private async run_once(
    key: string,
    platform: string,
    chat_id: string,
    user_id: string,
    text: string,
  ): Promise<GatewayReply> {
    const input = is_telegram_start(platform, text) === true ? "hello" : text;
    const history = this.history_for(key);
    const agent = this.ensure_agent();
    try {
      const result = await agent.run({ input, history, label: `gw:${platform}:${chat_id}` });
      this.store_history(key, cap_history(result.messages, this.history_cap));
      return { text: result.outcome.final?.content ?? "", usage: result.usage_total };
    } catch (error) {
      logger.error(`gateway bus run failed for ${key} (user ${user_id})`, error);
      const kept = history_after_run_error(error);
      if (kept !== undefined) {
        this.store_history(key, cap_history(kept, this.history_cap));
      }
      return { text: sanitize_agent_error(error), failed: true };
    }
  }

  /**
   * Re-inserts the key so Map order tracks the most recent use, then trims to
   * the cap: concurrent new chats can each pass `history_for` before any stores.
   */
  private store_history(key: string, messages: Message[]): void {
    this.histories.delete(key);
    this.histories.set(key, messages);
    while (this.histories.size > this.max_conversations) {
      const oldest = this.histories.keys().next();
      if (oldest.done === true || oldest.value === key) {
        break;
      }
      this.histories.delete(oldest.value);
    }
  }

  private ensure_agent(): Agent {
    if (this.agent === undefined) {
      this.agent = this.agent_factory();
    }
    return this.agent;
  }

  /** Least-recently-used eviction keeps the conversation map bounded. */
  private history_for(key: string): Message[] {
    while (this.histories.size >= this.max_conversations && this.histories.has(key) === false) {
      const oldest = this.histories.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.histories.delete(oldest.value);
    }
    return this.histories.get(key) ?? [];
  }

  /** Logs completed tool calls at debug level for gateway observability. */
  private wire_tool_logging(): void {
    const agent = this.agent_factory();
    this.agent = agent;
    this.stop_logging = agent.events.on((event) => {
      if (event.type === "tool_call_end") {
        logger.debug(`tool ${event.call.name} ${event.result.ok === true ? "ok" : "failed"}`);
      }
    });
  }
}

function conversation_key(platform: string, chat_id: string): string {
  return `${platform}:${chat_id}`;
}

/** Telegram's bot-start command (`/start`, `/start@bot`, `/start <payload>`); not `/started` or other platforms. */
function is_telegram_start(platform: string, text: string): boolean {
  return platform === "telegram" && /^\/start(@\w+)?(\s|$)/.test(text);
}

/**
 * Newest `cap` messages, starting at the first user message in the window.
 * When the window has no user message, drop a leading tool-result fragment so
 * it does not start mid-batch and keep the assistant/tool turns — skipping
 * every non-user role emptied a tool-heavy turn and the next message ran with
 * no history.
 * If the window is only that batch's results, include its assistant. The
 * slice can then exceed `cap` by the rest of that one batch. A window with no
 * user opens with a stub user turn, since providers reject assistant-first
 * history.
 */
function cap_history(messages: Message[], cap: number): Message[] {
  const overflow = messages.length - cap;
  if (overflow <= 0) {
    return messages;
  }
  const user = messages.findIndex((message, index) => index >= overflow && message.role === "user");
  if (user !== -1) {
    return messages.slice(user);
  }
  const body = skip_leading_tools(messages, overflow);
  if (body < messages.length) {
    return with_user_head(messages.slice(body));
  }
  const parent = assistant_owning_tools(messages, overflow);
  return parent === undefined ? [] : with_user_head(messages.slice(parent));
}

const TRIMMED_HISTORY_NOTE = "(earlier conversation trimmed)";

function with_user_head(window: Message[]): Message[] {
  return [{ role: "user", content: TRIMMED_HISTORY_NOTE }, ...window];
}

function skip_leading_tools(messages: readonly Message[], start: number): number {
  let index = start;
  while (index < messages.length && messages[index]?.role === "tool") {
    index += 1;
  }
  return index;
}

function assistant_owning_tools(messages: readonly Message[], start: number): number | undefined {
  let index = start;
  while (index > 0 && messages[index]?.role === "tool") {
    index -= 1;
  }
  const parent = messages[index];
  if (index >= start || parent?.role !== "assistant") {
    return undefined;
  }
  const calls = parent.tool_calls;
  return calls !== undefined && calls.length > 0 ? index : undefined;
}
