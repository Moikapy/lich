/**
 * Gateway token lookup is fail-closed: a blank override uses the historical
 * env name, an invalid name reads nothing, and an empty value does not fall
 * through to another token. Missing credentials leave the adapter idle.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse_agent_config, type AgentConfig } from "../src/agent/config.js";
import { create_discord_adapter } from "../src/gateway/discord.js";
import { create_telegram_adapter } from "../src/gateway/telegram.js";
import { platform_token_env, read_platform_token } from "../src/gateway/token_env.js";
import { create_twitch_adapter } from "../src/gateway/twitch.js";
import { run_inbound_message, sanitize_agent_error, type AdapterParams, type PlatformAdapter } from "../src/gateway/types.js";
import { logger } from "../src/util/log.js";

const sleep_calls = vi.hoisted(() => ({ n: 0 }));

vi.mock("../src/util/sleep.js", () => ({
  sleep: (): Promise<void> => {
    sleep_calls.n += 1;
    return Promise.resolve();
  },
}));

const touched = new Map<string, string | undefined>();

function set_env(key: string, value: string | undefined): void {
  if (touched.has(key) === false) {
    touched.set(key, process.env[key]);
  }
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function base_config(): AgentConfig {
  return parse_agent_config({
    providers: [{ kind: "openai_compat", name: "main", model: "mock-model" }],
    log_level: "error",
  });
}

function with_token_envs(token_envs: Record<string, string>): AgentConfig {
  const base = base_config();
  return {
    ...base,
    gateway: {
      platforms: [],
      token_envs,
      allowed_users: {},
      allowed_chats: {},
      tools_enabled: base.gateway?.tools_enabled ?? [],
    },
  };
}

function params_for(config: AgentConfig): AdapterParams {
  return {
    config,
    handle_message: async () => "unused",
    get_agent: () => {
      throw new Error("agent not used");
    },
    reply_router: () => undefined,
  };
}

function install_network_guards(): { fetches: string[]; sockets: string[] } {
  const fetches: string[] = [];
  const sockets: string[] = [];
  vi.stubGlobal("fetch", async (url: unknown) => {
    fetches.push(String(url));
    return new Response(JSON.stringify({ result: [] }), { status: 200 });
  });
  vi.stubGlobal(
    "WebSocket",
    class {
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;

      constructor(url: string) {
        sockets.push(url);
        queueMicrotask(() => {
          this.onerror?.({});
        });
      }

      send(_data: string): void {}

      close(): void {
        this.onclose?.();
      }
    },
  );
  return { fetches, sockets };
}

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await Promise.resolve();
  }
}

async function expect_idle(adapter: PlatformAdapter): Promise<void> {
  const net = install_network_guards();
  try {
    await adapter.start();
    await settle();
  } finally {
    await adapter.stop();
  }
  expect(net.fetches).toEqual([]);
  expect(net.sockets).toEqual([]);
}

function warn_text(): string {
  return vi.mocked(logger.warn).mock.calls.map((call) => String(call[0])).join("\n");
}

afterEach(() => {
  for (const [key, prior] of touched) {
    if (prior === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prior;
    }
  }
  touched.clear();
  sleep_calls.n = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("platform token env", () => {
  it("reads the historical name when config omits it, and a custom name wins", () => {
    set_env("LICH_DISCORD_BOT_TOKEN", "discord-default");
    set_env("LICH_TELEGRAM_BOT_TOKEN", "telegram-default");
    set_env("MY_TG_TOKEN", "telegram-custom");
    const plain = base_config();
    expect(platform_token_env(plain, "discord")).toBe("LICH_DISCORD_BOT_TOKEN");
    expect(read_platform_token(plain, "discord")).toBe("discord-default");
    expect(read_platform_token(plain, "slack")).toBeUndefined();
    const custom = with_token_envs({ telegram: "MY_TG_TOKEN" });
    expect(platform_token_env(custom, "telegram")).toBe("MY_TG_TOKEN");
    expect(read_platform_token(custom, "telegram")).toBe("telegram-custom");
  });

  it("treats a blank override as the historical name and an empty value as unset", () => {
    set_env("LICH_TELEGRAM_BOT_TOKEN", "from-default");
    set_env("MY_TG_TOKEN", "");
    const blank = with_token_envs({ telegram: "" });
    expect(platform_token_env(blank, "telegram")).toBe("LICH_TELEGRAM_BOT_TOKEN");
    expect(read_platform_token(blank, "telegram")).toBe("from-default");
    const empty_custom = with_token_envs({ telegram: "MY_TG_TOKEN" });
    expect(platform_token_env(empty_custom, "telegram")).toBe("MY_TG_TOKEN");
    expect(read_platform_token(empty_custom, "telegram")).toBeUndefined();
  });

  it("does not read an invalid env name or fall back to the default token", () => {
    set_env("1TOKEN", "should-not-read");
    set_env("LICH_TELEGRAM_BOT_TOKEN", "also-should-not-use");
    const forged = with_token_envs({ telegram: "1TOKEN" });
    expect(platform_token_env(forged, "telegram")).toBe("");
    expect(read_platform_token(forged, "telegram")).toBeUndefined();
  });
});

describe("adapter idle when the token is missing", () => {
  it("does not poll or open a socket when discord or telegram tokens are unset or empty", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    set_env("LICH_DISCORD_BOT_TOKEN", undefined);
    set_env("LICH_TELEGRAM_BOT_TOKEN", "");
    const discord = create_discord_adapter(params_for(base_config()));
    expect(warn_text()).toContain("gateway discord adapter idle: LICH_DISCORD_BOT_TOKEN not set");
    await expect_idle(discord);
    const telegram = create_telegram_adapter(params_for(base_config()));
    expect(warn_text()).toContain("gateway telegram adapter idle: LICH_TELEGRAM_BOT_TOKEN not set");
    await expect_idle(telegram);
    expect(sleep_calls.n).toBe(0);
  });

  it("stays idle for an invalid token name and does not echo that name or its value", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    set_env("1TOKEN", "should-not-read");
    set_env("LICH_TELEGRAM_BOT_TOKEN", "also-should-not-use");
    const adapter = create_telegram_adapter(params_for(with_token_envs({ telegram: "1TOKEN" })));
    const text = warn_text();
    expect(text).toContain("adapter idle");
    expect(text).not.toContain("1TOKEN");
    expect(text).not.toContain("should-not-read");
    expect(text).not.toContain("also-should-not-use");
    await expect_idle(adapter);
  });

  it("polls with the default token when the override is blank", async () => {
    set_env("LICH_TELEGRAM_BOT_TOKEN", "from-default");
    const net = install_network_guards();
    const adapter = create_telegram_adapter(params_for(with_token_envs({ telegram: "" })));
    try {
      await adapter.start();
      for (let attempt = 0; attempt < 20 && net.fetches.length === 0; attempt += 1) {
        await Promise.resolve();
      }
    } finally {
      await adapter.stop();
    }
    expect(net.fetches[0]).toContain("/botfrom-default/getUpdates");
    expect(net.sockets).toEqual([]);
  });

  it("does not open twitch when the nick or channel list is blank", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    set_env("LICH_TWITCH_OAUTH_TOKEN", "oauth-secret-value");
    set_env("LICH_TWITCH_NICK", undefined);
    set_env("LICH_TWITCH_CHANNELS", "lobby");
    await expect_idle(create_twitch_adapter(params_for(base_config())));
    set_env("LICH_TWITCH_NICK", "lichbot");
    set_env("LICH_TWITCH_CHANNELS", " , ");
    await expect_idle(create_twitch_adapter(params_for(base_config())));
    const text = warn_text();
    expect(text).toContain("adapter idle");
    expect(text).not.toContain("oauth-secret-value");
    expect(sleep_calls.n).toBe(0);
  });
});

describe("sanitize_agent_error", () => {
  it("keeps 300 characters, collapses whitespace, and replaces an empty message", async () => {
    const body = "a".repeat(300);
    expect(sanitize_agent_error(new Error(`${body}TAIL`))).toBe(`agent error: ${body}`);
    expect(sanitize_agent_error(new Error("  hi \n\t there  "))).toBe("agent error: hi there");
    expect(sanitize_agent_error(new Error(" \n\t "))).toBe("agent error: unknown");
    expect(sanitize_agent_error("plain")).toBe("agent error: plain");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const reply = await run_inbound_message(async () => {
      throw "  boom\nbang  ";
    }, "webhook", "c", "u", "hi");
    expect(reply).toBe("agent error: boom bang");
  });
});
