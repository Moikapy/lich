/**
 * Structural types the game repo can copy. No lich import — retarget
 * `run.ts` at `@moikapy/lich` when this folder leaves the checkout.
 */

export interface UsageShape {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface PersonaEntry {
  persona_id: string;
  system_prompt: string;
  tools_enabled: readonly string[];
  max_turns: number;
  max_tokens: number;
  context_budget_tokens: number;
  plugins: readonly string[];
}

export interface SharedAgentDefaults {
  providers: readonly unknown[];
  work_dir: string;
  session_dir?: string;
  log_level?: string;
}

export interface AgentLike {
  run(options: {
    input: string;
    history?: readonly unknown[];
    label?: string;
  }): Promise<AgentLikeResult>;
}

export interface AgentLikeResult {
  outcome: {
    stopped_reason: string;
    final?: { content?: string };
  };
  messages: readonly unknown[];
  usage_total: UsageShape;
}

export type AgentFactory = (raw_config: unknown) => Promise<AgentLike>;

export interface HandleResult {
  reply: string;
  usage: UsageShape | null;
}

/** Budget and abort leave orders to the game. Not an attack script. */
export type RoundFate = "use_model_reply" | "game_repo_decides";
