/**
 * Zod-validated agent configuration. Parsing applies defaults, computes the
 * derived session_dir, deep-freezes the result, and syncs the logger level.
 */
import { z } from "zod";
import { DEFAULT_GATEWAY_TOOLS_ENABLED } from "../gateway/access.js";
import { ENV_VAR_NAME } from "../gateway/token_env.js";
import { refuse_mcp_entry } from "../mcp/mcp_pin.js";
import { MODEL_ROLES } from "../plugins/types.js";
import type { ProviderConfig } from "../providers/types.js";
import { deep_freeze } from "../util/freeze.js";
import { set_log_level } from "../util/log.js";

const gateway_allowlist = z.record(z.string(), z.array(z.string())).default({});

const gateway_schema = z
  .object({
    platforms: z.array(z.enum(["webhook", "telegram", "discord", "twitch"])).default([]),
    /** Env-var names that hold tokens. Never store the secrets themselves. */
    token_envs: z.record(z.string(), z.string().regex(ENV_VAR_NAME, "invalid env var name")).default({}),
    /** Per-platform user ids allowed to talk to the bot (default-deny on public platforms). */
    allowed_users: gateway_allowlist,
    /** Per-platform chat/channel ids allowed (default-deny on public platforms). */
    allowed_chats: gateway_allowlist,
    /** Tool allowlist for the gateway agent; defaults to a read-only safe subset. */
    tools_enabled: z.union([z.literal("all"), z.array(z.string())]).default([...DEFAULT_GATEWAY_TOOLS_ENABLED]),
  })
  .optional();

const stdio_mcp_schema = z
  .object({
    enabled: z.boolean().default(false),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string().regex(ENV_VAR_NAME, "invalid env var name"), z.string()).optional(),
  })
  .strict();

const http_mcp_schema = z
  .object({
    enabled: z.boolean().default(false),
    url: z.string().min(1),
  })
  .strict();

const mcp_server_schema = z.union([stdio_mcp_schema, http_mcp_schema]);

const SERVER_NAME = /^[a-z][a-z0-9_]*$/;

const mcp_servers_schema = z
  .record(z.string(), mcp_server_schema)
  .superRefine((servers, ctx) => {
    for (const [name, entry] of Object.entries(servers)) {
      if (SERVER_NAME.test(name) === false) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: "mcp server name must be snake_case",
        });
      }
      const refused = refuse_mcp_entry(name, entry);
      if (refused !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: refused });
      }
    }
  })
  .optional();

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

const providers_schema = z
  .array(provider_schema)
  .min(1)
  .superRefine((providers, ctx) => {
    const seen = new Set<string>();
    for (const [index, provider] of providers.entries()) {
      if (seen.has(provider.name) === true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "name"],
          message: `duplicate provider name "${provider.name}"`,
        });
        continue;
      }
      seen.add(provider.name);
    }
  });

const role_schema = z.array(z.string().min(1)).min(1).optional();

/** Per-role provider chains by name. Omitted `chat` uses `providers` order; omitted `compress` uses the chat chain. */
const models_schema = z
  .object({
    /** Main loop failover order. */
    chat: role_schema,
    /** Context-compression chain; falls back to `chat` when it fails. */
    compress: role_schema,
  })
  .strict()
  .optional();

/** Bare module path, or `{ path, settings?, models? }` with free-form settings and granted roles. */
const plugin_entry_schema = z.union([
  z.string(),
  z
    .object({
      path: z.string().min(1),
      settings: z.record(z.unknown()).optional(),
      /** Model roles this plugin may call; default none (fail closed). */
      models: z.array(z.enum(MODEL_ROLES)).optional(),
    })
    .strict(),
]);

const agent_config_schema = z
  .object({
    /** Wizard label. The TUI banner uses the active theme welcome string. */
    agent_name: z.string().min(1).default("lich"),
    system_prompt: z.string().optional(),
    max_turns: z.number().int().min(1).default(25),
    providers: providers_schema,
    models: models_schema,
    work_dir: z.string().optional(),
    tools_enabled: z.union([z.literal("all"), z.array(z.string())]).default("all"),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().optional(),
    context_budget_tokens: z.number().int().positive().default(100000),
    compress_threshold: z.number().min(0.1).max(0.95).default(0.8),
    session_dir: z.string().optional(),
    terminal_timeout_ms: z.number().int().positive().default(60000),
    /** Plugin entries: module paths relative to work_dir or absolute, optionally with settings and roles. */
    plugins: z.array(plugin_entry_schema).default([]),
    gateway: gateway_schema,
    log_level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    theme: z.string().min(1).default("lich"),
    /** Named MCP servers. Each entry is stdio or loopback http. Default off. */
    mcp_servers: mcp_servers_schema,
  })
  .superRefine((config, ctx) => {
    const known = new Set(config.providers.map((provider) => provider.name));
    for (const [role, names] of Object.entries(config.models ?? {})) {
      const seen = new Set<string>();
      for (const [index, name] of (names ?? []).entries()) {
        if (known.has(name) === false) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["models", role, index],
            message: `unknown provider "${name}"`,
          });
        } else if (seen.has(name) === true) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["models", role, index],
            message: `provider "${name}" listed twice`,
          });
        }
        seen.add(name);
      }
    }
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
  if (config.models !== undefined) {
    Object.freeze(config.models.chat);
    Object.freeze(config.models.compress);
    Object.freeze(config.models);
  }
  Object.freeze(config.plugins);
  for (const plugin of config.plugins) {
    deep_freeze(plugin);
  }
  if (Array.isArray(config.tools_enabled) === true) {
    Object.freeze(config.tools_enabled);
  }
  if (config.gateway !== undefined) {
    Object.freeze(config.gateway.platforms);
    Object.freeze(config.gateway.token_envs);
    Object.freeze(config.gateway.allowed_users);
    Object.freeze(config.gateway.allowed_chats);
    if (Array.isArray(config.gateway.tools_enabled) === true) {
      Object.freeze(config.gateway.tools_enabled);
    }
    Object.freeze(config.gateway);
  }
  if (config.mcp_servers !== undefined) {
    for (const entry of Object.values(config.mcp_servers)) {
      if ("args" in entry) {
        Object.freeze(entry.args);
      }
      if ("env" in entry && entry.env !== undefined) {
        Object.freeze(entry.env);
      }
      Object.freeze(entry);
    }
    Object.freeze(config.mcp_servers);
  }
  return config;
}

export function parse_agent_config(raw: unknown): AgentConfig {
  const config: AgentConfig = agent_config_schema.parse(raw);
  const frozen = freeze_config(config);
  set_log_level(frozen.log_level);
  return frozen;
}