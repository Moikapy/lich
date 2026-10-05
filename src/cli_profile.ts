/**
 * `lich profile`: named configs under ~/.lich/profiles. A profile is merged
 * between the global ~/.lich/config.json and the project config; `<name>.md`
 * next to it, when present, becomes its system prompt.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { global_config_path, profile_paths, profiles_dir, read_config_object, write_lich_config } from "./cli_config.js";
import { ask_line, build_setup_config, collect_setup_answers } from "./setup_wizard.js";

function write_line(line: string): void {
  process.stdout.write(`${line}\n`);
}

function require_name(name: string | undefined, action: string): string {
  if (name === undefined || name.length === 0) {
    throw new Error(`profile ${action} requires a name`);
  }
  profile_paths(name);
  return name;
}

function read_global(): Record<string, unknown> {
  return existsSync(global_config_path()) === true ? read_config_object(global_config_path()) : {};
}

function sticky_profile(): string | undefined {
  const value = read_global()["profile"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function profile_names(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(profiles_dir());
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const entry of entries) {
    const match = /^([a-z0-9][a-z0-9_-]*)\.(json|md)$/.exec(entry);
    if (match?.[1] !== undefined) {
      names.add(match[1]);
    }
  }
  return [...names].sort();
}

function list_profiles(): void {
  const names = profile_names();
  if (names.length === 0) {
    write_line(`no profiles in ${profiles_dir()}`);
    return;
  }
  const active = sticky_profile();
  for (const name of names) {
    const soul = existsSync(profile_paths(name).soul) === true ? " (soul)" : "";
    write_line(`${name === active ? "*" : " "} ${name}${soul}`);
  }
}

function show_profile(name: string): void {
  const paths = profile_paths(name);
  if (existsSync(paths.json) === false && existsSync(paths.soul) === false) {
    throw new Error(`profile not found: ${name}`);
  }
  if (existsSync(paths.json) === true) {
    write_line(paths.json);
    write_line(readFileSync(paths.json, "utf8").trimEnd());
  }
  if (existsSync(paths.soul) === true) {
    write_line(`${paths.soul} (system prompt, ${readFileSync(paths.soul, "utf8").trim().length} chars)`);
  }
}

/** Run the setup wizard and write `~/.lich/profiles/<name>.json`; never overwrites. */
async function create_profile(name: string): Promise<number> {
  const paths = profile_paths(name);
  if (existsSync(paths.json) === true) {
    throw new Error(`profile ${name} already exists`);
  }
  if (process.stdin.isTTY !== true) {
    throw new Error("profile create needs a TTY; write the JSON by hand instead");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let config: Record<string, unknown>;
  try {
    // A directory with no .lich/plugins: project plugins do not belong in a profile.
    const answers = await collect_setup_answers(profiles_dir(), (prompt) => ask_line(rl, prompt));
    if (answers === undefined) {
      process.stderr.write("lich: profile create cancelled; nothing written\n");
      return 1;
    }
    config = build_setup_config(answers);
  } finally {
    rl.close();
  }
  mkdirSync(profiles_dir(), { recursive: true });
  // "wx": a profile created meanwhile is never overwritten.
  writeFileSync(paths.json, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  write_line(`wrote ${paths.json}`);
  return 0;
}

/** Record `name` as the sticky default (`profile` key in ~/.lich/config.json). */
function use_profile(name: string): void {
  const paths = profile_paths(name);
  if (existsSync(paths.json) === false && existsSync(paths.soul) === false) {
    throw new Error(`profile not found: ${name}`);
  }
  write_lich_config(homedir(), { ...read_global(), profile: name }, true);
  write_line(`default profile: ${name} (in ${global_config_path()})`);
}

export async function run_profile(positionals: readonly string[]): Promise<number> {
  const action = positionals[1];
  if (positionals.length > 3) {
    throw new Error("profile takes one name");
  }
  if (action === "list") {
    if (positionals[2] !== undefined) {
      throw new Error("profile list takes no name");
    }
    list_profiles();
    return 0;
  }
  if (action === "show") {
    show_profile(require_name(positionals[2], "show"));
    return 0;
  }
  if (action === "create") {
    return create_profile(require_name(positionals[2], "create"));
  }
  if (action === "use") {
    use_profile(require_name(positionals[2], "use"));
    return 0;
  }
  throw new Error("profile requires list, show, create, or use");
}
