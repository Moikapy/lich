#!/usr/bin/env node
/**
 * Thin zero-dependency CLI for lich: one-shot tasks, interactive chat,
 * config files, and environment-based provider resolution.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { create_agent_with_plugins, type Agent, type AgentRunResult } from "./agent/agent.js";
import { parse_agent_config, type AgentConfig } from "./agent/config.js";
import { AgentEmitter } from "./agent/events.js";
import { LICH_VERSION } from "./index.js";
import { load_config, config_template, existing_config_path, starter_config_object, write_lich_config } from "./cli_config.js";
import { run_mcp } from "./cli_mcp.js";
import { empty_mcp_flags, take_mcp_flag, type McpCliFlags } from "./cli_mcp_flags.js";
import { run_update } from "./cli_update.js";
import { ask_line as ask_wizard_line, build_setup_config, collect_setup_answers } from "./setup_wizard.js";
import { load_theme, notice_flavor } from "./util/theme.js";

type ProviderKind = "openai_compat" | "anthropic" | "ollama";

interface CliOptions {
  config_path?: string;
  resume?: string;
  help?: boolean;
  version?: boolean;
  overrides: Record<string, string>;
  positionals: string[];
  mcp_flags: McpCliFlags;
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
  "--theme": "theme",
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
    "lich — the undead agent harness",
    "",
    "Usage:",
    "  lich                   open the TUI (first run: setup wizard, then TUI)",
    "  lich init              write .lich/config.json without the wizard (flags apply; never overwrites)",
    '  lich "one shot task"   run a single task and print the reply',
    "  lich chat              interactive chat (commands: /exit, /quit)",
    "  lich tui               interactive terminal UI (ink)",
    "  lich gateway <plat..>  messaging gateway (webhook|telegram|discord|twitch)",
    "  lich config            print a starter config template (save as .lich/config.json)",
    "  lich update            install a newer @moikapy/lich from npm, if one exists",
    "  lich mcp list          list mcp servers in .lich/config.json",
    "  lich mcp add <name>    add a catalog or --command/--url server (disabled)",
    "  lich mcp enable <name> / disable <name> / remove <name>",
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
    "  --resume <id|latest>   TUI only: load an existing session transcript",
    "  --log-level <level>    debug | info | warn | error",
    "  --theme <name>         display theme (default lich; files in ~/.lich/themes)",
    "  --command <bin>        mcp add: local stdio binary",
    "  --arg <value>          mcp add: repeatable stdio arg (may start with --)",
    "  --url <url>            mcp add: loopback http url",
    "  --project-path <path>  mcp add: catalog ${project_path} substitute",
  ].join("\n");
}

function error_message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** --resume only applies to the TUI (including bare `lich`); reject other modes. */
function reject_resume_outside_tui(resume: string | undefined, mode: string): void {
  if (resume === undefined) {
    return;
  }
  throw new Error(`--resume is only supported in TUI mode (not ${mode})`);
}

/** Mode label for the resume guard; undefined means TUI is allowed. */
function non_tui_resume_mode(first: string | undefined): string | undefined {
  if (first === undefined || first === "tui") {
    return undefined;
  }
  if (
    first === "init" ||
    first === "config" ||
    first === "mcp" ||
    first === "update" ||
    first === "chat" ||
    first === "gateway"
  ) {
    return first;
  }
  return "one-shot";
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

export function parse_args(argv: string[]): CliOptions {
  const options: CliOptions = { overrides: {}, positionals: [], mcp_flags: empty_mcp_flags() };
  const mcp = argv.includes("mcp");
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
    if (arg === "--resume") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--resume requires a value");
      }
      options.resume = value;
      index += 1;
      continue;
    }
    if (mcp === true) {
      const consumed = take_mcp_flag(argv, index, options.mcp_flags);
      if (consumed !== undefined) {
        index = consumed;
        continue;
      }
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
  for (const key of ["work_dir", "system_prompt", "session_dir", "log_level", "theme"]) {
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

/** Same search as the wizard: `--work-dir` (else cwd), then the user-home file. */
function load_discovered_config(work_dir: string): Record<string, unknown> | undefined {
  const found = existing_config_path(work_dir);
  if (found === undefined) {
    return undefined;
  }
  return load_config(found);
}

function build_config(options: CliOptions): AgentConfig {
  const base =
    options.config_path === undefined
      ? load_discovered_config(work_dir_of(options)) ?? { providers: [env_provider(options.overrides)] }
      : load_config_file(options.config_path);
  apply_overrides(base, options.overrides);
  const providers = base["providers"];
  if (Array.isArray(providers) === false || providers.length === 0) {
    base["providers"] = [env_provider(options.overrides)];
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
  const theme = load_theme(agent.config.theme);
  const stop_progress = attach_progress(agent.events);
  let result: AgentRunResult;
  try {
    result = await agent.run({ input });
  } finally {
    stop_progress();
    agent.close();
  }
  const final = result.outcome.final;
  if (final !== undefined && final.content.length > 0) {
    process.stdout.write(`${final.content}\n`);
  }
  if (result.outcome.stopped_reason === "budget") {
    process.stderr.write(budget_stderr_line(result.outcome.turns_used, theme.notices.budget_exhausted));
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

function budget_stderr_line(turns: number, notice: string): string {
  const flavor = notice_flavor(notice);
  const suffix = flavor.length === 0 ? "" : ` — ${flavor}`;
  return `[lich] budget exhausted after ${turns} turns${suffix}\n`;
}

export async function run_chat(config: unknown): Promise<number> {
  const agent = await create_agent_with_plugins(config);
  const theme = load_theme(agent.config.theme);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const line = await ask_line(rl);
      if (line.trim() === "") {
        return 0;
      }
      const command = line.trim();
      if (command === "/exit" || command === "/quit") {
        process.stdout.write(`${theme.glyph} ${theme.goodbye}\n`);
        return 0;
      }
      await run_chat_turn(agent, command);
    }
  } finally {
    rl.close();
    agent.close();
  }
}

function model_hint(options: CliOptions): string | undefined {
  const model = options.overrides["provider_model"] ?? process.env.LICH_MODEL;
  if (model === undefined || model.length === 0) {
    return undefined;
  }
  return model;
}

function skip_setup_message(existing: string): string {
  if (existing.endsWith(`${path.sep}.lich${path.sep}config.json`) === true) {
    return `lich: .lich/config.json already exists at ${existing}; skipping setup`;
  }
  return `lich: config already exists at ${existing}; skipping setup`;
}

function work_dir_of(options: CliOptions): string {
  return options.overrides["work_dir"] ?? process.cwd();
}

async function offer_wizard(work_dir: string, hint?: string): Promise<string | "cancelled"> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answers = await collect_setup_answers(work_dir, (prompt) => ask_wizard_line(rl, prompt), hint);
    if (answers === undefined) {
      return "cancelled";
    }
    const result = write_lich_config(work_dir, build_setup_config(answers));
    process.stdout.write(`${result.message}\n`);
    return result.path;
  } finally {
    rl.close();
  }
}

async function maybe_first_run(options: CliOptions, work_dir: string): Promise<number | undefined> {
  if (options.config_path !== undefined) {
    return undefined;
  }
  const existing = existing_config_path(work_dir);
  if (existing !== undefined) {
    process.stdout.write(`${skip_setup_message(existing)}\n`);
    options.config_path = existing;
    return undefined;
  }
  const wrote = await offer_wizard(work_dir, model_hint(options));
  if (wrote === "cancelled") {
    process.stderr.write("lich: setup cancelled; nothing written\n");
    return 1;
  }
  options.config_path = wrote;
  return undefined;
}

async function run_bare(options: CliOptions): Promise<number> {
  if (process.stdin.isTTY !== true) {
    process.stderr.write("lich: stdin is not a TTY; skipping setup wizard. Run `lich init` to write .lich/config.json, or `lich --help` for usage.\n");
    return 1;
  }
  const work_dir = work_dir_of(options);
  const stopped = await maybe_first_run(options, work_dir);
  if (stopped !== undefined) {
    return stopped;
  }
  return run_tui_entry(build_config_for(options, "tui"), options.resume);
}

function model_still_placeholder(config: Record<string, unknown>): boolean {
  const providers = config["providers"];
  const first = Array.isArray(providers) === true ? providers[0] : undefined;
  if (typeof first !== "object" || first === null) {
    return false;
  }
  return (first as Record<string, unknown>)["model"] === "<model-name>";
}

function run_init(options: CliOptions): number {
  if (options.positionals.length > 1) {
    throw new Error("init takes no extra arguments");
  }
  const config = starter_config_object();
  apply_overrides(config, options.overrides);
  const result = write_lich_config(work_dir_of(options), config);
  process.stdout.write(`${result.message}\n`);
  if (result.written === true && model_still_placeholder(config) === true) {
    process.stdout.write("next: edit the model in .lich/config.json if needed, then run `lich`\n");
  }
  return 0;
}

async function run_tui_entry(config: ReturnType<typeof build_config>, resume?: string): Promise<number> {
  const { run_tui } = await import("./tui.js");
  if (resume === undefined) {
    return run_tui(config);
  }
  const { resolve_session_path } = await import("./session/resolve.js");
  const { read_session_messages } = await import("./session/store.js");
  const transcript = await resolve_session_path(config.session_dir, resume);
  const initial_history = await read_session_messages(transcript);
  const resumed_id = path.basename(transcript, ".jsonl");
  return run_tui(config, { initial_history, resumed_id });
}

function gateway_platforms(config: AgentConfig, cli_platforms: readonly string[]): readonly string[] {
  if (cli_platforms.length > 0) {
    return cli_platforms;
  }
  const configured = config.gateway?.platforms ?? [];
  return configured.length === 0 ? ["webhook"] : configured;
}

async function run_gateway_entry(config: AgentConfig, platforms: string[]): Promise<number> {
  const { run_gateway } = await import("./gateway.js");
  return run_gateway(config, gateway_platforms(config, platforms));
}

export interface CliEntryInput {
  bun: boolean;
  import_meta_main: boolean | undefined;
  module_url: string;
  argv1: string | undefined;
}

/** Bun uses `import.meta.main`. Node compares argv to this file, including a bin symlink. */
export function is_cli_entry(input: CliEntryInput): boolean {
  if (input.bun === true) {
    return input.import_meta_main === true;
  }
  return node_entry_matches(input.module_url, input.argv1);
}

function is_main_module(): boolean {
  return is_cli_entry({
    bun: process.versions.bun !== undefined,
    import_meta_main: import.meta.main,
    module_url: import.meta.url,
    argv1: process.argv[1],
  });
}

function node_entry_matches(module_url: string, entry: string | undefined): boolean {
  if (entry === undefined || entry === "") {
    return false;
  }
  const resolved = path.resolve(entry);
  if (module_url === pathToFileURL(resolved).href) {
    return true;
  }
  return same_real_file(fileURLToPath(module_url), resolved);
}

function same_real_file(left: string, right: string): boolean {
  if (existsSync(left) === false || existsSync(right) === false) {
    return false;
  }
  return realpathSync(left) === realpathSync(right);
}

export async function run_cli(argv: string[]): Promise<number> {
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
  const blocked_resume_mode = non_tui_resume_mode(first);
  if (blocked_resume_mode !== undefined) {
    reject_resume_outside_tui(options.resume, blocked_resume_mode);
  }
  if (first === undefined) {
    return run_bare(options);
  }
  if (first === "init") {
    return run_init(options);
  }
  if (first === "config") {
    process.stdout.write(`${config_template()}\n`);
    return 0;
  }
  if (first === "mcp") {
    return run_mcp(work_dir_of(options), options.positionals, options.mcp_flags);
  }
  if (first === "update") {
    if (options.positionals.length > 1) {
      throw new Error("update takes no arguments");
    }
    return run_update(fileURLToPath(import.meta.url));
  }
  if (first === "chat") {
    if (options.positionals.length > 1) {
      throw new Error("chat mode takes no task argument");
    }
    return run_chat(build_config_for(options, first));
  }
  if (first === "tui") {
    return run_tui_entry(build_config_for(options, first), options.resume);
  }
  if (first === "gateway") {
    return run_gateway_entry(build_config_for(options, first), options.positionals.slice(1));
  }
  return run_one_shot(build_config_for(options, "one-shot"), options.positionals.join(" "));
}

if (is_main_module() === true) {
  run_cli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`lich: ${error_message(error)}\n`);
      process.stderr.write("run `lich --help` for usage\n");
      process.exitCode = 1;
    });
}