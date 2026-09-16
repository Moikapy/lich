/**
 * One lich Agent per persona. This routes conversations; it does not run
 * a second Think-Act-Observe loop. Plugin tools stay inside the agent.
 */
import { cap_history, DEFAULT_HISTORY_CAP, DEFAULT_MAX_CONVERSATIONS, enqueue, recall_history } from "./history_queue.js";
import { parse_persona_chat_id, persona_by_id, persona_config } from "./personas.js";
import { reply_text, round_fate, sanitize_agent_error } from "./reply.js";
import type { AgentFactory, AgentLike, HandleResult, PersonaEntry, SharedAgentDefaults, UsageShape } from "./types.js";

export interface Orchestrator {
  handle(platform: string, chat_id: string, text: string): Promise<HandleResult>;
}

export interface OrchestratorParams {
  factory: AgentFactory;
  shared: SharedAgentDefaults;
  personas: readonly PersonaEntry[];
  history_cap?: number;
  max_conversations?: number;
}

export function create_orchestrator(params: OrchestratorParams): Orchestrator {
  const history_cap = params.history_cap ?? DEFAULT_HISTORY_CAP;
  const max_conversations = params.max_conversations ?? DEFAULT_MAX_CONVERSATIONS;
  const histories = new Map<string, readonly unknown[]>();
  const chains = new Map<string, Promise<void>>();
  const agents = new Map<string, AgentLike>();
  return {
    handle: (platform, chat_id, text) =>
      enqueue(chains, chat_id, () =>
        run_post(params, agents, histories, history_cap, max_conversations, platform, chat_id, text),
      ),
  };
}

async function run_post(
  params: OrchestratorParams,
  agents: Map<string, AgentLike>,
  histories: Map<string, readonly unknown[]>,
  history_cap: number,
  max_conversations: number,
  platform: string,
  chat_id: string,
  text: string,
): Promise<HandleResult> {
  const parsed = parse_persona_chat_id(chat_id);
  const persona = parsed === undefined ? undefined : persona_by_id(params.personas, parsed.persona_id);
  if (persona === undefined) {
    return { reply: sanitize_agent_error(new Error("unknown persona")), usage: null };
  }
  try {
    const agent = await agent_for(params.factory, params.shared, agents, persona);
    const history = recall_history(histories, chat_id, max_conversations) ?? [];
    const result = await agent.run({ input: text, history, label: `gw:${platform}:${chat_id}` });
    histories.set(chat_id, cap_history(result.messages, history_cap));
    return payload_for(result.outcome.stopped_reason, result.outcome.final?.content, result.usage_total);
  } catch (error) {
    return { reply: sanitize_agent_error(error), usage: null };
  }
}

async function agent_for(
  factory: AgentFactory,
  shared: SharedAgentDefaults,
  agents: Map<string, AgentLike>,
  persona: PersonaEntry,
): Promise<AgentLike> {
  const cached = agents.get(persona.persona_id);
  if (cached !== undefined) {
    return cached;
  }
  const created = await factory(persona_config(shared, persona));
  agents.set(persona.persona_id, created);
  return created;
}

function payload_for(stopped_reason: string, content: string | undefined, usage: UsageShape): HandleResult {
  const reply = reply_text(stopped_reason, content);
  // game_repo_decides still returns model text only. No order line is synthesized.
  if (round_fate(stopped_reason) === "game_repo_decides") {
    return { reply, usage };
  }
  return { reply, usage };
}
