/**
 * Gateway access: public-platform allowlists and the safe default toolset.
 */
import type { AgentConfig } from "../agent/config.js";
import { logger } from "../util/log.js";

const PUBLIC_PLATFORMS = new Set(["telegram", "discord", "twitch"]);

/** Read-only tools for gateway agents (no terminal, no filesystem writes). */
export const DEFAULT_GATEWAY_TOOLS_ENABLED: readonly string[] = [
  "read_file",
  "list_dir",
  "grep_files",
  "fetch_url",
  "web_search",
  "docs_read",
  "docs_search",
];

/** Tools the gateway agent should register (safe subset unless configured). */
export function gateway_tools_enabled(config: AgentConfig): "all" | readonly string[] {
  return config.gateway?.tools_enabled ?? DEFAULT_GATEWAY_TOOLS_ENABLED;
}

/** Default-deny on telegram/discord/twitch until allowlists list at least one entry. */
export function is_gateway_sender_allowed(
  config: AgentConfig,
  platform: string,
  chat_id: string,
  user_id: string,
): boolean {
  if (PUBLIC_PLATFORMS.has(platform) === false) {
    return true;
  }
  const users = config.gateway?.allowed_users?.[platform] ?? [];
  const chats = config.gateway?.allowed_chats?.[platform] ?? [];
  if (users.length === 0 && chats.length === 0) {
    return false;
  }
  const user_ok = users.length === 0 || users.includes(user_id);
  const chat_ok = chats.length === 0 || chats.includes(chat_id);
  return user_ok && chat_ok;
}

/** Logs and returns false when the sender is not on the allowlist. */
export function check_gateway_sender(
  config: AgentConfig,
  platform: string,
  chat_id: string,
  user_id: string,
): boolean {
  if (is_gateway_sender_allowed(config, platform, chat_id, user_id) === true) {
    return true;
  }
  logger.warn(`gateway denied ${platform} chat=${chat_id} user=${user_id}`);
  return false;
}
