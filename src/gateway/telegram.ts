/**
 * Telegram adapter: long-poll getUpdates over fetch and sendMessage
 * replies with 4096-char splitting. Missing token degrades to an idle
 * adapter instead of failing the gateway.
 */
import { sleep } from "../util/sleep.js";
import { logger } from "../util/log.js";
import { platform_token_env, read_platform_token } from "./token_env.js";
import type { AdapterParams, PlatformAdapter } from "./types.js";
import { create_idle_adapter, run_inbound_message } from "./types.js";

export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

interface TelegramUpdate {
  update_id?: number;
  message?: {
    text?: string;
    chat?: { id?: number | string };
    from?: { id?: number | string; is_bot?: boolean };
  };
}

export const TELEGRAM_BACKOFF_MS = [2000, 4000, 8000, 16000, 30000] as const;

export function create_telegram_adapter(params: AdapterParams): PlatformAdapter {
  const token = read_platform_token(params.config, "telegram");
  if (token === undefined) {
    return create_idle_adapter("telegram", `${platform_token_env(params.config, "telegram")} not set`);
  }
  let running = false;
  return {
    name: "telegram",
    start: async () => {
      running = true;
      void poll_loop(params, token, () => running);
    },
    stop: async () => {
      running = false;
    },
  };
}

async function poll_loop(params: AdapterParams, token: string, keep_running: () => boolean): Promise<void> {
  let offset = 0;
  let backoff_index = 0;
  while (keep_running()) {
    try {
      const updates = await fetch_updates(token, offset);
      backoff_index = 0;
      for (const update of updates) {
        offset = update.update_id !== undefined ? update.update_id + 1 : offset;
        void deliver_update(params, token, update);
      }
    } catch (error) {
      logger.warn("gateway telegram poll failed; backing off", error);
      await sleep(TELEGRAM_BACKOFF_MS[backoff_index] ?? 30000);
      backoff_index = Math.min(backoff_index + 1, TELEGRAM_BACKOFF_MS.length - 1);
    }
  }
}

async function fetch_updates(token: string, offset: number): Promise<TelegramUpdate[]> {
  const url = api_url(token, "getUpdates") + `?timeout=50&offset=${offset}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (response.ok === false) {
    throw new Error(`getUpdates http ${response.status}`);
  }
  const body = (await response.json()) as { result?: TelegramUpdate[] };
  return Array.isArray(body.result) === true ? body.result : [];
}

async function deliver_update(params: AdapterParams, token: string, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (message === undefined || message.from?.is_bot === true) {
    return;
  }
  const chat_id = message.chat?.id;
  if (chat_id === undefined) {
    return;
  }
  const text = message.text ?? "media not supported yet";
  const reply = await run_inbound_message(
    params.handle_message,
    "telegram",
    String(chat_id),
    String(message.from?.id ?? "unknown"),
    text,
  );
  await send_reply(token, String(chat_id), reply);
}

async function send_reply(token: string, chat_id: string, text: string): Promise<void> {
  for (const chunk of split_text(text, TELEGRAM_MAX_MESSAGE_CHARS)) {
    await post_json(api_url(token, "sendMessage"), { chat_id, text: chunk });
  }
}

async function post_json(url: string, payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.ok === false) {
    logger.warn(`gateway telegram sendMessage failed with http ${response.status}`);
  }
}

function api_url(token: string, method: string): string {
  return `https://api.telegram.org/bot${token}/${method}`;
}

/** Splits at the last newline/space inside each window; hard cut fallback. */
export function split_text(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    const newline = window.lastIndexOf("\n");
    const space = window.lastIndexOf(" ");
    const cut = newline > 0 ? newline : space > 0 ? space : limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) {
    chunks.push(rest);
  }
  return chunks;
}