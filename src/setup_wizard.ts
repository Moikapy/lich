/**
 * First-run setup wizard. Builds an AgentConfig object; does not write the file.
 * Callers pass the object to write_lich_config.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import type { Interface } from "node:readline";
import { DEFAULT_GATEWAY_TOKEN_ENVS, is_env_var_name } from "./gateway/token_env.js";

export type ProviderKind = "ollama" | "openai_compat" | "anthropic";

const PLATFORMS = ["webhook", "telegram", "discord", "twitch"] as const;
const PLUGIN_EXT = /\.(mjs|js|ts|mts|cts|jsx|tsx)$/;

const PROVIDER_DEFAULTS: Record<ProviderKind, { model: string; base_url: string; api_key_env?: string }> = {
  ollama: { model: "llama3.2", base_url: "http://localhost:11434" },
  openai_compat: { model: "gpt-4.1-mini", base_url: "https://api.openai.com/v1", api_key_env: "OPENAI_API_KEY" },
  anthropic: { model: "claude-sonnet-4", base_url: "https://api.anthropic.com", api_key_env: "ANTHROPIC_API_KEY" },
};

export interface SetupAnswers {
  agent_name: string;
  provider_kind: ProviderKind;
  model: string;
  base_url: string;
  api_key_env?: string;
  platforms: string[];
  token_envs: Record<string, string>;
  plugins: string[];
}

export type AskLine = (prompt: string) => Promise<string | undefined>;

/** Plugin entry files under `.lich/plugins`, as work_dir-relative specifiers. */
function discover_plugin_entries(work_dir: string): string[] {
  const dir = path.resolve(work_dir, ".lich", "plugins");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: string[] = [];
  for (const name of names) {
    if (PLUGIN_EXT.test(name) === true) {
      entries.push(path.posix.join(".lich/plugins", name));
    }
  }
  return entries;
}

/** Object the agent schema already accepts. Omits gateway when no platforms were chosen. */
export function build_setup_config(answers: SetupAnswers): Record<string, unknown> {
  const provider: Record<string, unknown> = {
    kind: answers.provider_kind,
    name: "main",
    model: answers.model,
    base_url: answers.base_url,
  };
  if (answers.api_key_env !== undefined && answers.api_key_env.length > 0) {
    provider["api_key_env"] = answers.api_key_env;
  }
  const config: Record<string, unknown> = {
    agent_name: answers.agent_name,
    providers: [provider],
    max_turns: 25,
    plugins: answers.plugins,
  };
  if (answers.platforms.length > 0) {
    config["gateway"] = { platforms: answers.platforms, token_envs: answers.token_envs };
  }
  return config;
}

function blank_as_default(raw: string, fallback: string): string {
  const trimmed = raw.trim();
  return trimmed.length === 0 ? fallback : trimmed;
}

function parse_kind(raw: string): ProviderKind | undefined {
  const trimmed = raw.trim();
  const kind = trimmed.length === 0 ? "ollama" : trimmed;
  if (kind === "ollama" || kind === "openai_compat" || kind === "anthropic") {
    return kind;
  }
  return undefined;
}

function parse_platforms(raw: string): string[] {
  const seen = new Set<string>();
  const platforms: string[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim().toLowerCase();
    if ((PLATFORMS as readonly string[]).includes(name) === false || seen.has(name) === true) {
      continue;
    }
    seen.add(name);
    platforms.push(name);
  }
  return platforms;
}

/** One prompt. Resolves undefined on Ctrl+C or a closed stream so nothing is written. */
export function ask_line(rl: Interface, prompt: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled === true) {
        return;
      }
      settled = true;
      rl.removeListener("SIGINT", on_sigint);
      rl.removeListener("close", on_close);
      resolve(value);
    };
    const on_sigint = (): void => finish(undefined);
    const on_close = (): void => finish(undefined);
    rl.once("SIGINT", on_sigint);
    rl.once("close", on_close);
    rl.question(prompt, (answer) => finish(answer));
  });
}

async function ask_name(ask: AskLine): Promise<string | undefined> {
  const raw = await ask("Agent name [lich]: ");
  if (raw === undefined) {
    return undefined;
  }
  return blank_as_default(raw, "lich");
}

async function ask_provider(
  ask: AskLine,
  model_hint?: string,
): Promise<Pick<SetupAnswers, "provider_kind" | "model" | "base_url" | "api_key_env"> | undefined> {
  const kind_raw = await ask("Provider kind (ollama|openai_compat|anthropic) [ollama]: ");
  if (kind_raw === undefined) {
    return undefined;
  }
  let kind = parse_kind(kind_raw);
  if (kind === undefined) {
    const retry = await ask("Unknown kind. Provider kind (ollama|openai_compat|anthropic) [ollama]: ");
    if (retry === undefined) {
      return undefined;
    }
    kind = parse_kind(retry) ?? "ollama";
  }
  const defaults = PROVIDER_DEFAULTS[kind];
  const model_default = model_hint !== undefined && model_hint.length > 0 ? model_hint : defaults.model;
  const model_raw = await ask(`Model [${model_default}]: `);
  if (model_raw === undefined) {
    return undefined;
  }
  const url_raw = await ask(`Base URL [${defaults.base_url}]: `);
  if (url_raw === undefined) {
    return undefined;
  }
  const key_default = defaults.api_key_env ?? "";
  const key_prompt = key_default.length === 0 ? "API key env var name (empty to skip): " : `API key env var name [${key_default}]: `;
  const key_raw = await ask(key_prompt);
  if (key_raw === undefined) {
    return undefined;
  }
  const api_key_env = blank_as_default(key_raw, key_default);
  return {
    provider_kind: kind,
    model: blank_as_default(model_raw, model_default),
    base_url: blank_as_default(url_raw, defaults.base_url),
    api_key_env: api_key_env.length === 0 ? undefined : api_key_env,
  };
}

function token_env_name(raw: string, fallback: string): string | undefined {
  const name = blank_as_default(raw, fallback);
  return is_env_var_name(name) === true ? name : undefined;
}

async function ask_token_env(ask: AskLine, platform: string, fallback: string): Promise<string | undefined> {
  const first = await ask(`${platform} token env var [${fallback}] (name only, not the secret): `);
  if (first === undefined) {
    return undefined;
  }
  const named = token_env_name(first, fallback);
  if (named !== undefined) {
    return named;
  }
  const retry = await ask(`Env var name must match [A-Za-z_][A-Za-z0-9_]* [${fallback}]: `);
  if (retry === undefined) {
    return undefined;
  }
  return token_env_name(retry, fallback);
}

async function ask_gateway(ask: AskLine): Promise<{ platforms: string[]; token_envs: Record<string, string> } | undefined> {
  const raw = await ask("Gateway platforms (webhook,telegram,discord,twitch; empty to skip): ");
  if (raw === undefined) {
    return undefined;
  }
  const platforms = parse_platforms(raw);
  const token_envs: Record<string, string> = {};
  for (const platform of platforms) {
    const name = await ask_token_env(ask, platform, DEFAULT_GATEWAY_TOKEN_ENVS[platform] ?? "");
    if (name === undefined) {
      return undefined;
    }
    token_envs[platform] = name;
  }
  return { platforms, token_envs };
}

async function ask_plugins(work_dir: string, ask: AskLine): Promise<string[] | undefined> {
  const found = discover_plugin_entries(work_dir);
  if (found.length === 0) {
    return [];
  }
  const enabled: string[] = [];
  for (const entry of found) {
    const answer = await ask(`Enable plugin ${entry}? [y/N]: `);
    if (answer === undefined) {
      return undefined;
    }
    const yes = answer.trim().toLowerCase();
    if (yes === "y" || yes === "yes") {
      enabled.push(entry);
    }
  }
  return enabled;
}

/** All steps skippable. Undefined means Ctrl+C or a rejected env name: caller must not write. */
export async function collect_setup_answers(work_dir: string, ask: AskLine, model_hint?: string): Promise<SetupAnswers | undefined> {
  const agent_name = await ask_name(ask);
  if (agent_name === undefined) {
    return undefined;
  }
  const provider = await ask_provider(ask, model_hint);
  if (provider === undefined) {
    return undefined;
  }
  const gateway = await ask_gateway(ask);
  if (gateway === undefined) {
    return undefined;
  }
  const plugins = await ask_plugins(work_dir, ask);
  if (plugins === undefined) {
    return undefined;
  }
  return { agent_name, ...provider, platforms: gateway.platforms, token_envs: gateway.token_envs, plugins };
}
