/**
 * Gateway token lookup: config stores env-var names, never secret values.
 * A blank or omitted override falls back to the historical LICH_* name.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/agent/config.js";
import { read_platform_token } from "../src/gateway/token_env.js";

const TOUCHED = ["LICH_TELEGRAM_BOT_TOKEN", "MY_TG_TOKEN", ""] as const;
const saved = new Map<string, string | undefined>();

function remember(): void {
  for (const key of TOUCHED) {
    if (saved.has(key) === false) {
      saved.set(key, process.env[key]);
    }
  }
}

function restore(): void {
  for (const [key, value] of saved) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  saved.clear();
}

function config_with(token_envs: Record<string, string>): AgentConfig {
  return { gateway: { token_envs } } as AgentConfig;
}

afterEach(() => {
  restore();
});

describe("read_platform_token", () => {
  it("uses the historical env when the platform is omitted or blank, and only the override when set", () => {
    remember();
    process.env.LICH_TELEGRAM_BOT_TOKEN = "fixture-telegram-token";
    process.env[""] = "should-not-read";
    const omitted = config_with({});
    expect(read_platform_token(omitted, "telegram")).toBe("fixture-telegram-token");
    expect(read_platform_token(config_with({ telegram: "" }), "telegram")).toBe("fixture-telegram-token");
    expect(read_platform_token(omitted, "unknown")).toBeUndefined();

    delete process.env.LICH_TELEGRAM_BOT_TOKEN;
    const override = config_with({ telegram: "MY_TG_TOKEN" });
    expect(read_platform_token(override, "telegram")).toBeUndefined();
    process.env.MY_TG_TOKEN = "fixture-override";
    expect(read_platform_token(override, "telegram")).toBe("fixture-override");
  });
});
