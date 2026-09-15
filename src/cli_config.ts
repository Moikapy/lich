/**
 * Config-file discovery for the CLI: an ordered search chain, safe loading,
 * and a starter template so `lich tui` works with zero environment setup.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { safe_json_parse } from "./util/json.js";

const LICH_DIRNAME = ".lich";
const CONFIG_RELPATH = `${LICH_DIRNAME}/config.json`;
const DEFAULT_USER_CONFIG = ".config/lich/config.json";

/** Ordered absolute chain: work_dir (default cwd) first, then the user config home. */
export function config_search_paths(work_dir?: string): string[] {
  const root = work_dir ?? process.cwd();
  const first = path.resolve(root, CONFIG_RELPATH);
  const second = path.resolve(homedir(), DEFAULT_USER_CONFIG);
  return first === second ? [first] : [first, second];
}

/** Explicit path must exist (else throw); otherwise walk the chain, undefined when absent. */
export function find_config_file(explicit?: string): string | undefined {
  if (explicit !== undefined) {
    if (existsSync(explicit) === false) {
      throw new Error(`config not found: ${explicit}`);
    }
    return explicit;
  }
  for (const candidate of config_search_paths()) {
    if (existsSync(candidate) === true) {
      return candidate;
    }
  }
  return undefined;
}

/** Load the first config found as an object; undefined when absent, throw on bad json. */
export function load_config(explicit?: string): Record<string, unknown> | undefined {
  const found = find_config_file(explicit);
  if (found === undefined) {
    return undefined;
  }
  const raw = readFileSync(found, "utf8");
  const parsed = safe_json_parse<unknown>(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`invalid config json: ${found}`);
  }
  return parsed as Record<string, unknown>;
}

/** Starter config honoring LICH_* env hints; `lich config` prints it. */
export function config_template(): string {
  const kind = process.env.LICH_PROVIDER_KIND ?? "ollama";
  const provider: Record<string, unknown> = {
    kind,
    name: "main",
    model: process.env.LICH_MODEL ?? "<model-name>",
  };
  if (kind === "ollama") {
    provider["base_url"] = "http://localhost:11434";
  }
  return JSON.stringify({ providers: [provider], max_turns: 25 }, null, 2);
}

/** mkdir -p `${work_dir}/.lich` and return the directory path. */
export function ensure_lich_config_dir(work_dir: string): string {
  const dir = path.resolve(work_dir, LICH_DIRNAME);
  mkdirSync(dir, { recursive: true });
  return dir;
}