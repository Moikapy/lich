/**
 * Zod-validated agent configuration. Parsing applies defaults, computes the
 * derived session_dir, deep-freezes the result, and syncs the logger level.
 */
import { z } from "zod";
import type { ProviderConfig } from "../providers/types.js";
import { set_log_level } from "../util/log.js";

const provider_schema = z
  .object({
    kind: z.enum(["openai_compat", "anthropic", "ollama"]),
    name: z.string().min(1),
    model: z.string().min(1),
    base_url: z.string().optional(),
    api_key: z.string().optional(),
    api_key_env: z.string().optional(),
    timeout_ms: z.number().int().positive().optional(),
    /** Injectable fetch, mainly for tests; passes through untouched. */
    fetch_fn: z.custom<typeof fetch>(() => true).optional(),
  })
  .passthrough();

const agent_config_schema = z
  .object({
    system_prompt: z.string().optional(),
    max_turns: z.number().int().min(1).default(25),
    providers: z.array(provider_schema).min(1),
    work_dir: z.string().optional(),
    tools_enabled: z.union([z.literal("all"), z.array(z.string())]).default("all"),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().optional(),
    context_budget_tokens: z.number().int().positive().default(100000),
    compress_threshold: z.number().min(0.1).max(0.95).default(0.8),
    session_dir: z.string().optional(),
    terminal_timeout_ms: z.number().int().positive().default(60000),
    /** Plugin entry module specifiers, relative to work_dir or absolute. */
    plugins: z.array(z.string()).default([]),
    log_level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  })
  .transform((config) => {
    const work_dir = config.work_dir ?? process.cwd();
    return {
      ...config,
      work_dir,
      providers: config.providers as ProviderConfig[],
      session_dir: config.session_dir ?? `${work_dir}/.lich/sessions`,
    };
  });

export type AgentConfig = z.infer<typeof agent_config_schema>;

function freeze_config(config: AgentConfig): AgentConfig {
  Object.freeze(config);
  Object.freeze(config.providers);
  for (const provider of config.providers) {
    Object.freeze(provider);
  }
  return config;
}

export function parse_agent_config(raw: unknown): AgentConfig {
  const config: AgentConfig = agent_config_schema.parse(raw);
  const frozen = freeze_config(config);
  set_log_level(frozen.log_level);
  return frozen;
}