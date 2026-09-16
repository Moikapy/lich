#!/usr/bin/env node
/**
 * Thin zero-dependency CLI for lich: one-shot tasks, interactive chat,
 * config files, and environment-based provider resolution.
 */
import { readFileSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { create_agent_with_plugins, type Agent, type AgentRunResult } from "./agent/agent.js";
import { parse_agent_config, type AgentConfig } from "./agent/config.js";
import { AgentEmitter } from "./agent/events.js";
import { LICH_VERSION } from "./index.js";
import { load_config, config_template } from "./cli_config.js";

type ProviderKind = "openai_compat" | "anthropic" | "ollama";

interface CliOptions {
  config_path?: string;
  help?: boolean;
  version?: boolean;
  overrides: Record<string, string>;
  positionals: string[];
}

const FLAG_KEYS: Record<string, string> = {
  "--work-dir": "work_dir",
  "--max-turns": "max_turns",
  "--model": "provider_model",
  "--provider-kind": "provider_kind",
  "--base-url": "provider_base_url",
  "--api-key-env": "provider_api_key_env",
  "--system-prompt": "system_prompt",
  "--session-dir": "session_dir",
  "--log-level": "log_level",
};

const DEFAULT_BASE_URLS: Record<ProviderKind, string> = {
  openai_compat: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  ollama: "http://localhost:11434",
};

const DEFAULT_ENV_API_KEYS: Record<ProviderKind, string | undefined> = {
  openai_compat: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  ollama: undefined, // ollama needs no api key
};

function usage_text(): string {
  return [
    "lich — a TypeScript AI agent harness",
    "",
    "Usage:",
    '  lich "one shot task"   run a single task and print the reply',
    "  lich chat              interactive chat (commands: /exit, /quit)",
    "  lich tui               interactive terminal UI (ink)",
    "  lich gateway <plat..>  messaging gateway (webhook|telegram|discord|twitch)",
    "  lich config            print a starter config template (save as .lich/config.json)",
    "  lich --help            show this help",
    "  lich --version         print version",
    "",
    "Flags (before or after the subcommand):",
    "  --config <path>        JSON config file parsed by parse_agent_config",
    "  --work-dir <path>      working directory for tools",
    "  --max-turns <n>        loop turn budget (default 25)",
    "  --model <m>            model name (default from LICH_MODEL)",
    "  --provider-kind <k>    openai_compat | anthropic | ollama (default LICH_PROVIDER_KIND)",
    "  --base-url <u>         provider base url (default LICH_BASE_URL)",
    "  --api-key-env <NAME>   env var holding the api key (default LICH_API_KEY_ENV; unused by ollama)",
    "  --system-prompt <s>    system prompt override",
    "  --session-dir <path>   session transcript directory",
    "  --log-level <level>    debug | info | warn | error",
  ].join("\n");
}

function error_message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Mode-aware config failure message; one-shot keeps the generic variant. */
function error_for_mode(mode: string, base_message: string): string {
  if (mode === "tui") {
    return "lich tui: no model configured — set LICH_MODEL (e.g. glm-5.3-flash:cloud), pass --model, or create .lich/config.json (`lich config` prints a template)";
  }
  if (mode === "gateway") {
    return "lich gateway: no model configured — set LICH_MODEL (e.g. glm-5.3-flash:cloud), pass --model, or create .lich/config.json (`lich config` prints a template)";
  }
  if (mode === "chat") {
    return "lich chat: no model configured — set LICH_MODEL (e.g. glm-5.3-flash:cloud), pass --model, or create .lich/config.json (`lich config` prints a template)";
  }
  return base_message;
}

function parse_args(argv: string[]): CliOptions {
  const options: CliOptions = { overrides: {}, positionals: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--version") {
      options.version = true;
      continue;
    }
    if (arg === "--config") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--config requires a path");
      }
      options.config_path = value;
      index += 1;
      continue;
    }
    const override_key = FLAG_KEYS[arg];
    if (override_key === undefined) {
      if (arg.startsWith("--") === true) {
        throw new Error(`unknown flag: ${arg}`);
      }
      options.positionals.push(arg);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--") === true) {
      throw new Error(`${arg} requires a value`);
    }
    options.overrides[override_key] = value;
    index += 1;
  }
  return options;
}

function env_provider(overrides: Record<string, string>): Record<string, unknown> {
  const kind_value = overrides["provider_kind"] ?? process.env.LICH_PROVIDER_KIND ?? "openai_compat";
  if (kind_value !== "openai_compat" && kind_value !== "anthropic" && kind_value !== "ollama") {
    throw new Error(`unknown provider kind "${kind_value}" (expected openai_compat, anthropic, or ollama)`);
  }
  const kind: ProviderKind = kind_value;
  const model = overrides["provider_model"] ?? process.env.LICH_MODEL;
  if (model === undefined || model.length === 0) {
    throw new Error("no model configured: set LICH_MODEL, pass --model, or create .lich/config.json (`lich config` prints a template)");
  }
  return {
    kind,
    name: "default",
    model,
    base_url: overrides["provider_base_url"] ?? process.env.LICH_BASE_URL ?? DEFAULT_BASE_URLS[kind],
    api_key_env: overrides["provider_api_key_env"] ?? process.env.LICH_API_KEY_ENV ?? DEFAULT_ENV_API_KEYS[kind],
  };
}

function load_config_file(config_path: string): Record<string, unknown> {
  try {
    const raw = readFileSync(config_path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("config root must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`cannot use config file ${config_path}: ${error_message(error)}`);
  }
}

function apply_provider_override(config: Record<string, unknown>, overrides: Record<string, string>): void {
  const keys = ["provider_kind", "provider_model", "provider_base_url", "provider_api_key_env"] as const;
  const any_present = keys.some((key) => overrides[key] !== undefined);
  if (any_present === false) {
    return;
  }
  const providers = config["providers"];
  if (Array.isArray(providers) === false || providers.length === 0) {
    config["providers"] = [env_provider(overrides)];
    return;
  }
  const first = providers[0];
  if (typeof first !== "object" || first === null) {
    throw new Error("config providers[0] must be an object");
  }
  const provider = first as Record<string, unknown>;
  for (const key of keys) {
    const value = overrides[key];
    if (value !== undefined) {
      provider[key.replace("provider_", "")] = value;
    }
  }
}

function apply_overrides(config: Record<string, unknown>, overrides: Record<string, string>): void {
  for (const key of ["work_dir", "system_prompt", "session_dir", "log_level"]) {
    if (overrides[key] !== undefined) {
      config[key] = overrides[key];
    }
  }
  if (overrides["max_turns"] !== undefined) {
    const turns = Number(overrides["max_turns"]);
    if (Number.isInteger(turns) === false || turns < 1) {
      throw new Error("--max-turns must be a positive integer");
    }
    config["max_turns"] = turns;
  }
  apply_provider_override(config, overrides);
}

function build_config(options: CliOptions): AgentConfig {
  const base =
    options.config_path === undefined ? load_config() ?? { providers: [env_provider(options.overrides)] } : load_config_file(options.config_path);
  apply_overrides(base, options.overrides);
  const providers = base["providers"];
  if (Array.isArray(providers) === false || providers.length === 0) {
    throw new Error("no model configured: set LICH_MODEL, pass --model, or create .lich/config.json (`lich config` prints a template)");
  }
  return parse_agent_config(base);
}

/** build_config with the failure message prefixed for the invoking subcommand. */
function build_config_for(options: CliOptions, mode: string): AgentConfig {
  try {
    return build_config(options);
  } catch (error) {
    throw new Error(error_for_mode(mode, error_message(error)));
  }
}

function attach_progress(emitter: AgentEmitter): () => void {
  return emitter.on((event) => {
    if (event.type === "turn_start") {
      process.stderr.write(`\n[lich] turn ${event.turn}`);
      return;
    }
    if (event.type === "tool_call_end") {
      const status = event.result.ok === true ? "ok" : `error: ${event.result.error ?? ""}`;
      process.stderr.write(`\n[lich]   ${event.call.name}: ${status}`);
      return;
    }
    if (event.type === "final") {
      process.stderr.write("\n");
    }
  });
}

export async function run_one_shot(config: unknown, input: string): Promise<number> {
  const agent = await create_agent_with_plugins(config);
  const stop_progress = attach_progress(agent.events);
  let result: AgentRunResult;
  try {
    result = await agent.run({ input });
  } finally {
    stop_progress();
  }
  const final = result.outcome.final;
  if (final !== undefined && final.content.length > 0) {
    process.stdout.write(`${final.content}\n`);
  }
  if (result.outcome.stopped_reason === "budget") {
    process.stderr.write(`[lich] budget exhausted after ${result.outcome.turns_used} turns\n`);
    return 1;
  }
  if (result.outcome.stopped_reason === "aborted") {
    process.stderr.write("[lich] run aborted\n");
    return 1;
  }
  return 0;
}

async function run_chat_turn(agent: Agent, input: string): Promise<void> {
  const stop_progress = attach_progress(agent.events);
  try {
    const result = await agent.run({ input });
    const final = result.outcome.final;
    if (final !== undefined && final.content.length > 0) {
      process.stdout.write(`${final.content}\n`);
    }
    process.stdout.write(`[turns ${result.outcome.turns_used} | tokens ${result.usage_total.total_tokens}]\n`);
  } catch (error) {
    process.stderr.write(`[lich] ${error_message(error)}\n`);
  } finally {
    stop_progress();
  }
}

function ask_line(rl: Interface): Promise<string> {
  return new Promise((resolve) => {
    const on_close = (): void => resolve("");
    rl.question("> ", (answer) => {
      rl.removeListener("close", on_close);
      resolve(answer);
    });
    rl.once("close", on_close);
  });
}

export async function run_chat(config: unknown): Promise<number> {
  const agent = await create_agent_with_plugins(config);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const line = await ask_line(rl);
      if (line.trim() === "") {
        return 0;
      }
      const command = line.trim();
      if (command === "/exit" || command === "/quit") {
        return 0;
      }
      await run_chat_turn(agent, command);
    }
  } finally {
    rl.close();
  }
}

async function run_tui_entry(config: ReturnType<typeof build_config>): Promise<number> {
  const { run_tui } = await import("./tui.js");
  return run_tui(config);
}

async function run_gateway_entry(
  config: ReturnType<typeof build_config>,
  platforms: string[],
): Promise<number> {
  const { run_gateway } = await import("./gateway.js");
  return run_gateway(config, platforms.length === 0 ? ["webhook"] : platforms);
}

function is_main_module(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

async function main(argv: string[]): Promise<number> {
  const options = parse_args(argv);
  if (options.help === true) {
    process.stdout.write(`${usage_text()}\n`);
    return 0;
  }
  if (options.version === true) {
    process.stdout.write(`${LICH_VERSION}\n`);
    return 0;
  }
  const [first] = options.positionals;
  if (first === undefined) {
    process.stderr.write(`${usage_text()}\n`);
    return 1;
  }
  if (first === "config") {
    process.stdout.write(`${config_template()}\n`);
    return 0;
  }
  if (first === "chat") {
    if (options.positionals.length > 1) {
      throw new Error("chat mode takes no task argument");
    }
    return run_chat(build_config_for(options, first));
  }
  if (first === "tui") {
    return run_tui_entry(build_config_for(options, first));
  }
  if (first === "gateway") {
    return run_gateway_entry(build_config_for(options, first), options.positionals.slice(1));
  }
  return run_one_shot(build_config_for(options, "one-shot"), options.positionals.join(" "));
}

if (is_main_module() === true) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`lich: ${error_message(error)}\n`);
      process.stderr.write("run `lich --help` for usage\n");
      process.exitCode = 1;
    });
}