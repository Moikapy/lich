/**
 * Config-file discovery for the CLI: an ordered search chain, safe loading,
 * and a starter template so `lich tui` works with zero environment setup.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  return existing_config_path(process.cwd());
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

/** Project config path: the first entry in the search chain. */
export function project_config_path(work_dir: string): string {
  return path.resolve(work_dir, CONFIG_RELPATH);
}

/** First existing file on `config_search_paths(work_dir)`. */
export function existing_config_path(work_dir: string): string | undefined {
  for (const candidate of config_search_paths(work_dir)) {
    if (existsSync(candidate) === true) {
      return candidate;
    }
  }
  return undefined;
}

export interface LichConfigWriteResult {
  path: string;
  written: boolean;
  message: string;
}

/** Parsed `config_template()` object. Does not write. */
export function starter_config_object(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(config_template());
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("config template must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Create `.lich/` and write `config.json` once. The only writer of that file.
 * Existing files are left untouched.
 */
export function write_lich_config(work_dir: string, config: Record<string, unknown>): LichConfigWriteResult {
  ensure_lich_config_dir(work_dir);
  const file = project_config_path(work_dir);
  if (existsSync(file) === true) {
    return already_exists(file);
  }
  try {
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (is_eexist(error) === true) {
      return already_exists(file);
    }
    throw error;
  }
  return { path: file, written: true, message: `wrote ${file}` };
}

function already_exists(file: string): LichConfigWriteResult {
  return {
    path: file,
    written: false,
    message: `lich: .lich/config.json already exists at ${file}; not overwriting`,
  };
}

function is_eexist(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}
