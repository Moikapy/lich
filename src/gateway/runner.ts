/**
 * Gateway runner: wires the shared Agent, the conversation bus, and the
 * requested platform adapters, then stays alive until a signal arrives.
 */
import { create_agent_with_plugins, type Agent } from "../agent/agent.js";
import type { AgentConfig } from "../agent/config.js";
import { logger } from "../util/log.js";
import { create_gateway_policy } from "./access.js";
import { GatewayBus } from "./bus.js";
import { create_discord_adapter } from "./discord.js";
import { create_telegram_adapter } from "./telegram.js";
import { create_twitch_adapter } from "./twitch.js";
import type { AdapterParams, PlatformAdapter } from "./types.js";
import { create_webhook_adapter } from "./webhook.js";

/** Preload plugins, then hand that same agent to the bus factory. */
export async function create_gateway_bus(config: AgentConfig): Promise<{ agent: Agent; bus: GatewayBus }> {
  const policy = create_gateway_policy(config);
  const agent_config = { ...config, tools_enabled: policy.tools_enabled };
  const agent = await create_agent_with_plugins(agent_config);
  const bus = new GatewayBus({ config, policy, agent_factory: () => agent, wire_tool_logging: true });
  return { agent, bus };
}

export async function run_gateway(config: AgentConfig, platforms: readonly string[]): Promise<number> {
  const valid: string[] = [];
  for (const platform of platforms) {
    if (is_known_platform(platform) === true) {
      valid.push(platform);
    } else {
      process.stderr.write(`lich: unknown gateway platform "${platform}" (skipping)\n`);
    }
  }
  if (valid.length === 0) {
    process.stderr.write("lich: gateway needs at least one valid platform (webhook|telegram|discord|twitch)\n");
    return 1;
  }
  const { agent, bus } = await create_gateway_bus(config);
  const adapters = build_adapters(config, bus, valid);
  install_signal_handlers(agent, bus, adapters);
  logger.info(`gateway starting: platforms=${valid.join(",")}, port=${process.env.LICH_GATEWAY_PORT ?? "8089"}, pid=${process.pid}`);
  await start_all_adapters(adapters);
  return await new Promise<number>(() => undefined);
}

function is_known_platform(platform: string): boolean {
  return platform === "webhook" || platform === "telegram" || platform === "discord" || platform === "twitch";
}

function build_adapters(config: AgentConfig, bus: GatewayBus, platforms: readonly string[]): PlatformAdapter[] {
  const params: AdapterParams = {
    config,
    handle_message: (platform, chat_id, user_id, text) => bus.reply(platform, chat_id, user_id, text),
    get_agent: () => {
      throw new Error("get_agent is reserved for future use");
    },
    reply_router: () => undefined,
  };
  const adapters: PlatformAdapter[] = [];
  for (const platform of platforms) {
    const adapter = create_platform_adapter(params, platform);
    if (adapter !== undefined) {
      adapters.push(adapter);
    }
  }
  return adapters;
}

function create_platform_adapter(params: AdapterParams, platform: string): PlatformAdapter | undefined {
  switch (platform) {
    case "webhook":
      return create_webhook_adapter({ ...params, port: read_webhook_port(), host: read_webhook_host() });
    case "telegram":
      return create_telegram_adapter(params);
    case "discord":
      return create_discord_adapter(params);
    case "twitch":
      return create_twitch_adapter(params);
    default:
      return undefined;
  }
}

function read_webhook_port(): number | undefined {
  const raw = process.env.LICH_GATEWAY_PORT;
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

function read_webhook_host(): string | undefined {
  const raw = process.env.LICH_GATEWAY_HOST;
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  return raw.trim();
}

/** Adapter start failures log and are skipped; the rest keep running. */
async function start_all_adapters(adapters: readonly PlatformAdapter[]): Promise<void> {
  for (const adapter of adapters) {
    try {
      await adapter.start();
      const cap = adapter.capabilities.max_reply_chars;
      logger.info(`gateway adapter started: ${adapter.name} (${adapter.capabilities.kind}${cap === undefined ? "" : `, replies split at ${cap} chars`})`);
    } catch (error) {
      logger.error(`gateway adapter failed to start: ${adapter.name}`, error);
    }
  }
}

/** Upper bound on waiting for adapters to stop, so a hung platform socket cannot block exit. */
const SHUTDOWN_TIMEOUT_MS = 5000;

/** Stops every adapter and waits for them (bounded), then releases the bus and agent. */
export async function shutdown_gateway(
  agent: Agent,
  bus: GatewayBus,
  adapters: readonly PlatformAdapter[],
  timeout_ms = SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  const stops = Promise.allSettled(
    adapters.map((adapter) =>
      adapter.stop().catch((error: unknown) => logger.warn(`gateway adapter stop failed: ${adapter.name}`, error)),
    ),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      logger.warn(`gateway adapters did not stop within ${timeout_ms}ms; exiting anyway`);
      resolve();
    }, timeout_ms);
  });
  await Promise.race([stops, timeout]);
  clearTimeout(timer);
  bus.stop();
  agent.close();
}

function install_signal_handlers(agent: Agent, bus: GatewayBus, adapters: readonly PlatformAdapter[]): void {
  const shutdown = (): void => {
    void shutdown_gateway(agent, bus, adapters).finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}