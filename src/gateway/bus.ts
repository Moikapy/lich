/**
 * GatewayBus: conversation-keyed runner over one shared Agent.
 *
 * Per-conversation history lives in a bounded Map; concurrent messages for
 * the same conversation are serialized through a promise chain so history
 * never interleaves. Agent failures become sanitized reply strings.
 */
import type { Agent } from "../agent/agent.js";
import type { AgentConfig } from "../agent/config.js";
import type { Message } from "../providers/types.js";
import { logger } from "../util/log.js";
import { check_gateway_sender } from "./access.js";
import { sanitize_agent_error } from "./types.js";

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
  private readonly chains: Map<string, Promise<void>> = new Map();
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

  /** Serializes runs per conversation and resolves to the reply text. */
  async handle(platform: string, chat_id: string, user_id: string, text: string): Promise<string | undefined> {
    if (check_gateway_sender(this.config, platform, chat_id, user_id) === false) {
      return undefined;
    }
    const key = conversation_key(platform, chat_id);
    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous.then(() => this.run_once(key, platform, chat_id, user_id, text));
    this.chains.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
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
  ): Promise<string | undefined> {
    const input = text.startsWith("/start") === true ? "hello" : text;
    const history = this.history_for(key);
    const agent = this.ensure_agent();
    try {
      const result = await agent.run({ input, history, label: `gw:${platform}:${chat_id}` });
      this.histories.set(key, cap_history(result.messages, this.history_cap));
      return final_reply_text(result.outcome.final?.content);
    } catch (error) {
      logger.error(`gateway bus run failed for ${key} (user ${user_id})`, error);
      return sanitize_agent_error(error);
    }
  }

  private ensure_agent(): Agent {
    if (this.agent === undefined) {
      this.agent = this.agent_factory();
    }
    return this.agent;
  }

  /** Oldest-first eviction keeps the conversation map bounded. */
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

function cap_history(messages: Message[], cap: number): Message[] {
  const overflow = messages.length - cap;
  if (overflow <= 0) {
    return messages;
  }
  return messages.slice(overflow);
}

function final_reply_text(content: string | undefined): string | undefined {
  return content === undefined || content.length === 0 ? undefined : content;
}