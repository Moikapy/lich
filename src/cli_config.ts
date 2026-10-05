/**
 * Config-file discovery for the CLI: an ordered search chain, safe loading,
 * and a starter template so `lich tui` works with zero environment setup.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { safe_json_parse } from "./util/json.js";

const LICH_DIRNAME = ".lich";
const CONFIG_RELPATH = `${LICH_DIRNAME}/config.json`;
/** Read only when `~/.lich/config.json` is absent; never written. */
const LEGACY_USER_CONFIG = ".config/lich/config.json";
/** Keys that stay per project: a global layer never sets them. */
const PROJECT_ONLY_KEYS = ["work_dir", "session_dir"] as const;
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]*$/;

export type ProviderKind = "openai_compat" | "anthropic" | "ollama";

export interface ProviderKindDefaults {
  base_url: string;
  api_key_env?: string;
}

const KIND_DEFAULTS: Record<ProviderKind, ProviderKindDefaults> = {
  openai_compat: { base_url: "https://api.openai.com/v1", api_key_env: "OPENAI_API_KEY" },
  anthropic: { base_url: "https://api.anthropic.com", api_key_env: "ANTHROPIC_API_KEY" },
  ollama: { base_url: "http://localhost:11434" },
};

/** Default base_url / api_key_env for a provider kind (CLI flags and templates). */
export function provider_kind_defaults(kind: ProviderKind): ProviderKindDefaults {
  return KIND_DEFAULTS[kind];
}

function parse_template_kind(raw: string): ProviderKind {
  if (raw === "openai_compat" || raw === "anthropic" || raw === "ollama") {
    return raw;
  }
  return "ollama";
}

/** The global default config: `~/.lich/config.json`. */
export function global_config_path(): string {
  return path.resolve(homedir(), CONFIG_RELPATH);
}

/** True when the legacy file is the live user config (no `~/.lich/config.json` yet). */
export function legacy_user_config_active(): boolean {
  if (existsSync(global_config_path()) === true) {
    return false;
  }
  return existsSync(path.resolve(homedir(), LEGACY_USER_CONFIG));
}

export interface GlobalConfigSeed {
  config: Record<string, unknown>;
  /** True when `config` was read from the legacy file, not `~/.lich/config.json`. */
  from_legacy: boolean;
  /** Permission bits of the legacy file, when it seeded `config`. */
  mode?: number;
}

/**
 * Object to write into `~/.lich/config.json`. An existing global file is
 * returned unchanged. Otherwise the legacy file seeds the write, with plugin
 * paths already resolved, so creating the global file does not drop it.
 */
export function global_config_seed(): GlobalConfigSeed {
  if (existsSync(global_config_path()) === true) {
    return { config: read_config_object(global_config_path()), from_legacy: false };
  }
  const legacy = path.resolve(homedir(), LEGACY_USER_CONFIG);
  if (existsSync(legacy) === false) {
    return { config: {}, from_legacy: false };
  }
  return {
    config: global_layer(read_config_object(legacy), path.dirname(legacy)),
    from_legacy: true,
    mode: statSync(legacy).mode & 0o777,
  };
}

/**
 * Ordered absolute chain: the work_dir (default cwd) project config, the
 * global `~/.lich/config.json`, then the legacy `~/.config/lich/config.json`.
 */
export function config_search_paths(work_dir?: string): string[] {
  const root = work_dir ?? process.cwd();
  const chain = [path.resolve(root, CONFIG_RELPATH), global_config_path(), path.resolve(homedir(), LEGACY_USER_CONFIG)];
  return chain.filter((entry, index) => chain.indexOf(entry) === index);
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
  return read_config_object(found);
}

export interface LayeredConfig {
  config: Record<string, unknown>;
  /** Files merged, base first. */
  sources: string[];
  /** One-line notices for the user (for example, the legacy location in use). */
  notes: string[];
  /** The profile merged in, when one was selected. */
  profile?: string;
}

/** `~/.lich/profiles`: one `<name>.json` (and optional `<name>.md` soul) per profile. */
export function profiles_dir(): string {
  return path.resolve(homedir(), LICH_DIRNAME, "profiles");
}

/** The JSON and soul paths for a profile name; throws on a name that is not a plain slug. */
export function profile_paths(name: string): { json: string; soul: string } {
  if (PROFILE_NAME.test(name) === false) {
    throw new Error(`invalid profile name "${name}" (use lowercase letters, digits, - and _)`);
  }
  return { json: path.join(profiles_dir(), `${name}.json`), soul: path.join(profiles_dir(), `${name}.md`) };
}

/**
 * A profile as a layer: its JSON (paths resolved against `~/.lich/profiles`) with
 * a non-empty soul file as `system_prompt`. Throws when neither file exists.
 */
function profile_layer(name: string): { layer: Record<string, unknown>; sources: string[] } {
  const paths = profile_paths(name);
  const has_json = existsSync(paths.json);
  const has_soul = existsSync(paths.soul);
  if (has_json === false && has_soul === false) {
    throw new Error(`profile not found: ${name}`);
  }
  const layer = has_json === true ? global_layer(read_config_object(paths.json), profiles_dir()) : {};
  delete layer["profile"];
  const soul = has_soul === true ? readFileSync(paths.soul, "utf8").trim() : "";
  if (soul.length > 0) {
    layer["system_prompt"] = soul;
  }
  return { layer, sources: [paths.json, paths.soul].filter((file) => existsSync(file) === true) };
}

/**
 * Project `.lich/config.json` merged over the global base (`~/.lich/config.json`,
 * else the legacy `~/.config/lich/config.json`), with a selected profile in
 * between. The profile is `profile_flag`, else `LICH_PROFILE`, else a `profile`
 * key in the project file, else one in the global file. Undefined when no file exists.
 */
export function load_layered_config(work_dir: string, profile_flag?: string): LayeredConfig | undefined {
  const project_path = project_config_path(work_dir);
  const global_path = global_config_path();
  const legacy = path.resolve(homedir(), LEGACY_USER_CONFIG);
  const notes: string[] = [];
  let base_path: string | undefined;
  if (existsSync(global_path) === true) {
    // When work_dir is home, the global file is the project file: no base layer.
    base_path = global_path === project_path ? undefined : global_path;
  } else if (existsSync(legacy) === true) {
    base_path = legacy;
    notes.push(`lich: reading ${legacy}; move it to ${global_path} (the old location is read-only)`);
  }
  const project = existsSync(project_path) === true ? read_config_object(project_path) : undefined;
  const base = base_path === undefined ? undefined : global_layer(read_config_object(base_path), path.dirname(base_path));
  const selected = first_profile_name([profile_flag, process.env.LICH_PROFILE, project?.["profile"], base?.["profile"]]);
  const profile = selected === undefined ? undefined : profile_layer(selected);
  if (project === undefined && base === undefined && profile === undefined) {
    return undefined;
  }
  const sources = [
    ...(base_path === undefined ? [] : [base_path]),
    ...(profile?.sources ?? []),
    ...(project === undefined ? [] : [project_path]),
  ];
  // With work_dir = home the project file is the global file, so the profile goes over it.
  const config =
    project_path === global_path && project !== undefined
      ? merge_config_layers(project, profile?.layer ?? {})
      : merge_config_layers(merge_config_layers(base ?? {}, profile?.layer ?? {}), project ?? {});
  delete config["profile"];
  return { config, sources, notes, ...(selected === undefined ? {} : { profile: selected }) };
}

function first_profile_name(candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Shallow merge, project wins per key. A project `providers` array replaces
 * the base's; the base `models` is then dropped unless the project sets its
 * own, since its role chains name the base's providers.
 */
export function merge_config_layers(
  base: Record<string, unknown>,
  project: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...base, ...project };
  if (Object.hasOwn(project, "providers") === true && Object.hasOwn(project, "models") === false) {
    delete merged["models"];
  }
  return merged;
}

/**
 * A global file as a base layer: per-project keys are ignored, and relative
 * plugin paths resolve against the file's own directory instead of the project.
 */
function global_layer(config: Record<string, unknown>, home: string): Record<string, unknown> {
  const layer = { ...config };
  for (const key of PROJECT_ONLY_KEYS) {
    delete layer[key];
  }
  const plugins = layer["plugins"];
  if (Array.isArray(plugins) === true) {
    layer["plugins"] = plugins.map((entry: unknown) => {
      if (typeof entry === "string") {
        return path.resolve(home, entry);
      }
      if (typeof entry === "object" && entry !== null && typeof (entry as { path?: unknown }).path === "string") {
        return { ...entry, path: path.resolve(home, (entry as { path: string }).path) };
      }
      return entry;
    });
  }
  return layer;
}

export function read_config_object(found: string): Record<string, unknown> {
  const raw = readFileSync(found, "utf8");
  const parsed = safe_json_parse<unknown>(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`invalid config json: ${found}`);
  }
  return parsed as Record<string, unknown>;
}

/** Starter config honoring LICH_* env hints; `lich config` prints it. */
export function config_template(): string {
  const kind = parse_template_kind(process.env.LICH_PROVIDER_KIND ?? "ollama");
  const defaults = provider_kind_defaults(kind);
  const provider: Record<string, unknown> = {
    kind,
    name: "main",
    model: process.env.LICH_MODEL ?? "<model-name>",
    base_url: defaults.base_url,
  };
  if (defaults.api_key_env !== undefined) {
    provider["api_key_env"] = defaults.api_key_env;
  }
  return JSON.stringify({ providers: [provider], max_turns: 25, theme: "lich" }, null, 2);
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
 * The only writer of `.lich/config.json`. Create leaves an existing file
 * untouched. `update` replaces that file with the object the caller built,
 * so a caller must keep unrelated keys itself.
 */
export function write_lich_config(
  work_dir: string,
  config: Record<string, unknown>,
  update = false,
): LichConfigWriteResult {
  ensure_lich_config_dir(work_dir);
  const file = project_config_path(work_dir);
  if (existsSync(file) === true && update !== true) {
    return already_exists(file);
  }
  const text = `${JSON.stringify(config, null, 2)}\n`;
  if (update === true) {
    replace_file(file, text);
    return { path: file, written: true, message: `updated ${file}` };
  }
  try {
    writeFileSync(file, text, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (is_eexist(error) === true) {
      return already_exists(file);
    }
    throw error;
  }
  return { path: file, written: true, message: `wrote ${file}` };
}

/**
 * Write a sibling temp file, then rename it over `file`, so readers never see
 * a partial config. The temp file takes the existing file's mode.
 */
function replace_file(file: string, text: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  const mode = statSync(file, { throwIfNoEntry: false })?.mode;
  try {
    // Create it with the old mode so a 0600 config is never briefly wider.
    writeFileSync(temp, text, { encoding: "utf8", mode: mode === undefined ? undefined : mode & 0o777 });
    if (mode !== undefined) {
      chmodSync(temp, mode);
    }
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
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
