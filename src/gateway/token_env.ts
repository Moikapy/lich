/**
 * Gateway token lookup: config stores env-var names, never secret values.
 * Adapters fall back to the historical LICH_* names when config omits them.
 */
import type { AgentConfig } from "../agent/config.js";

export const DEFAULT_GATEWAY_TOKEN_ENVS: Readonly<Record<string, string>> = {
  webhook: "LICH_GATEWAY_TOKEN",
  telegram: "LICH_TELEGRAM_BOT_TOKEN",
  discord: "LICH_DISCORD_BOT_TOKEN",
  twitch: "LICH_TWITCH_OAUTH_TOKEN",
};

/** POSIX env-var names only. Rejected names are never logged. */
export const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function is_env_var_name(value: string): boolean {
  return ENV_VAR_NAME.test(value) === true;
}

/** Env-var name for a platform token: valid config override, else the historical default. */
export function platform_token_env(config: AgentConfig, platform: string): string {
  const named = config.gateway?.token_envs[platform];
  if (named !== undefined && named.length > 0) {
    return is_env_var_name(named) === true ? named : "";
  }
  return DEFAULT_GATEWAY_TOKEN_ENVS[platform] ?? "";
}

/** Secret currently exported under the platform's token env name, if any. */
export function read_platform_token(config: AgentConfig, platform: string): string | undefined {
  const key = platform_token_env(config, platform);
  if (is_env_var_name(key) === false) {
    return undefined;
  }
  const value = process.env[key];
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return value;
}
