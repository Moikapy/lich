/**
 * Unit tests for CLI config-file discovery: search chain, explicit paths,
 * safe JSON loading, and the starter template printed by `lich config`.
 */
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  config_search_paths,
  config_template,
  ensure_lich_config_dir,
  find_config_file,
  global_config_path,
  load_config,
  load_layered_config,
  merge_config_layers,
  project_config_path,
  write_lich_config,
} from "../src/cli_config.js";

const TEST_TMP_ROOT = path.resolve("test/.tmp/cli-config");
const created: string[] = [];

function make_temp_dir(prefix: string): string {
  mkdirSync(TEST_TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(path.join(TEST_TMP_ROOT, `${prefix}-`));
  created.push(dir);
  return dir;
}

/** Run `body` with the process cwd inside a fresh temp dir, restoring after. */
function with_cwd_in_temp(prefix: string, body: (dir: string) => void): void {
  const previous = process.cwd();
  const dir = make_temp_dir(prefix);
  process.chdir(dir);
  try {
    body(dir);
  } finally {
    process.chdir(previous);
  }
}

function with_env_vars(overrides: Record<string, string | undefined>, body: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  try {
    body();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("config_search_paths", () => {
  it("lists the cwd .lich config, then ~/.lich/config.json, then the legacy ~/.config/lich file", () => {
    const paths = config_search_paths();
    expect(paths).toEqual([
      path.resolve(process.cwd(), ".lich/config.json"),
      path.resolve(homedir(), ".lich/config.json"),
      path.resolve(homedir(), ".config/lich/config.json"),
    ]);
  });

  it("lists the global file once when the work_dir is the home directory", () => {
    expect(config_search_paths(homedir())).toEqual([
      path.resolve(homedir(), ".lich/config.json"),
      path.resolve(homedir(), ".config/lich/config.json"),
    ]);
  });

  it("resolves the first entry from the requested work_dir", () => {
    const paths = config_search_paths("/some/work/dir");
    expect(paths[0]).toBe("/some/work/dir/.lich/config.json");
  });

  it("keeps both entries ordered for a work_dir inside the config home", () => {
    const paths = config_search_paths(path.join(homedir(), ".config/lich"));
    expect(paths[0]).toBe(path.resolve(homedir(), ".config/lich/.lich/config.json"));
    expect(paths[2]).toBe(path.resolve(homedir(), ".config/lich/config.json"));
  });
});

describe("find_config_file", () => {
  it("throws when an explicit path is missing", () => {
    expect(() => find_config_file("/no/such/config.json")).toThrow("config not found: /no/such/config.json");
  });

  it("returns an explicit path when it exists", () => {
    const dir = make_temp_dir("explicit");
    const file = path.join(dir, "my.json");
    writeFileSync(file, "{}\n");
    expect(find_config_file(file)).toBe(file);
  });

  it("finds the first chain entry relative to the cwd", () => {
    with_cwd_in_temp("chain-first", (dir) => {
      mkdirSync(path.join(dir, ".lich"));
      writeFileSync(path.join(dir, ".lich", "config.json"), "{}\n");
      expect(find_config_file()).toBe(path.join(dir, ".lich", "config.json"));
    });
  });

  it("returns undefined when no chain entry exists", () => {
    with_cwd_in_temp("chain-empty", (dir) => {
      expect(find_config_file()).toBeUndefined();
      expect(dir.length).toBeGreaterThan(0);
    });
  });
});

describe("load_config", () => {
  it("throws on invalid json", () => {
    with_cwd_in_temp("bad-json", (dir) => {
      mkdirSync(path.join(dir, ".lich"));
      writeFileSync(path.join(dir, ".lich", "config.json"), "{not json");
      expect(() => load_config()).toThrow("invalid config json:");
    });
  });

  it("returns the parsed object for valid json", () => {
    with_cwd_in_temp("good-json", (dir) => {
      mkdirSync(path.join(dir, ".lich"));
      writeFileSync(path.join(dir, ".lich", "config.json"), '{"providers":[]}');
      expect(load_config()).toEqual({ providers: [] });
    });
  });

  it("returns undefined when no config exists", () => {
    with_cwd_in_temp("no-file", () => {
      expect(load_config()).toBeUndefined();
    });
  });
});

describe("config_template", () => {
  it("parses as json with a providers array and defaults", () => {
    with_env_vars({ LICH_MODEL: undefined, LICH_PROVIDER_KIND: undefined }, () => {
      const template = JSON.parse(config_template()) as {
        providers: Array<Record<string, unknown>>;
        max_turns: number;
      };
      expect(Array.isArray(template.providers)).toBe(true);
      expect(template.providers[0]?.["kind"]).toBe("ollama");
      expect(template.providers[0]?.["name"]).toBe("main");
      expect(template.providers[0]?.["model"]).toBe("<model-name>");
      expect(template.providers[0]?.["base_url"]).toBe("http://localhost:11434");
      expect(template.max_turns).toBe(25);
      expect((template as { theme?: string }).theme).toBe("lich");
    });
  });

  it("honors LICH_MODEL in the generated template", () => {
    with_env_vars({ LICH_MODEL: "test-model", LICH_PROVIDER_KIND: undefined }, () => {
      const template = JSON.parse(config_template()) as { providers: Array<Record<string, unknown>> };
      expect(template.providers[0]?.["model"]).toBe("test-model");
    });
  });

  it("sets anthropic defaults when LICH_PROVIDER_KIND is anthropic", () => {
    with_env_vars({ LICH_MODEL: undefined, LICH_PROVIDER_KIND: "anthropic" }, () => {
      const template = JSON.parse(config_template()) as { providers: Array<Record<string, unknown>> };
      expect(template.providers[0]?.["kind"]).toBe("anthropic");
      expect(template.providers[0]?.["base_url"]).toBe("https://api.anthropic.com");
      expect(template.providers[0]?.["api_key_env"]).toBe("ANTHROPIC_API_KEY");
    });
  });
});

describe("ensure_lich_config_dir", () => {
  it("creates .lich under the work dir, idempotently, and returns its path", () => {
    const dir = make_temp_dir("ensure");
    const lich_dir = ensure_lich_config_dir(dir);
    expect(lich_dir).toBe(path.join(dir, ".lich"));
    expect(existsSync(lich_dir)).toBe(true);
    expect(() => ensure_lich_config_dir(dir)).not.toThrow();
  });
});

describe("load_layered_config", () => {
  let saved_home: string | undefined;
  let home: string;

  let saved_profile: string | undefined;

  beforeEach(() => {
    saved_home = process.env.HOME;
    saved_profile = process.env.LICH_PROFILE;
    home = make_temp_dir("home");
    process.env.HOME = home;
    delete process.env.LICH_PROFILE;
  });

  afterEach(() => {
    for (const [key, value] of [["HOME", saved_home], ["LICH_PROFILE", saved_profile]] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  function write_json(file: string, value: unknown): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  }

  it("returns undefined when neither a project nor a global config exists", () => {
    expect(load_layered_config(make_temp_dir("none"))).toBeUndefined();
  });

  it("merges the project over ~/.lich/config.json per key", () => {
    const work = make_temp_dir("work");
    write_json(global_config_path(), { agent_name: "wight", max_turns: 9, theme: "lich" });
    write_json(project_config_path(work), { max_turns: 3 });
    const layered = load_layered_config(work);
    expect(layered?.config).toEqual({ agent_name: "wight", max_turns: 3, theme: "lich" });
    expect(layered?.sources).toEqual([global_config_path(), project_config_path(work)]);
    expect(layered?.notes).toEqual([]);
  });

  it("ignores work_dir and session_dir from the global layer and resolves its plugin paths against ~/.lich", () => {
    const work = make_temp_dir("work");
    write_json(global_config_path(), {
      work_dir: "/elsewhere",
      session_dir: "/elsewhere/sessions",
      plugins: ["./plugins/a.mjs", { path: "b.mjs", settings: { x: 1 } }, "/abs/c.mjs"],
    });
    const config = load_layered_config(work)?.config;
    expect(config?.["work_dir"]).toBeUndefined();
    expect(config?.["session_dir"]).toBeUndefined();
    expect(config?.["plugins"]).toEqual([
      path.join(home, ".lich", "plugins", "a.mjs"),
      { path: path.join(home, ".lich", "b.mjs"), settings: { x: 1 } },
      "/abs/c.mjs",
    ]);
  });

  it("keeps project plugin paths and work_dir as written", () => {
    const work = make_temp_dir("work");
    write_json(global_config_path(), { plugins: ["./g.mjs"] });
    write_json(project_config_path(work), { work_dir: work, plugins: ["./p.mjs"] });
    expect(load_layered_config(work)?.config).toEqual({ work_dir: work, plugins: ["./p.mjs"] });
  });

  it("reads the legacy ~/.config/lich file only when ~/.lich/config.json is absent, with a note", () => {
    const work = make_temp_dir("work");
    const legacy = path.join(home, ".config", "lich", "config.json");
    write_json(legacy, { agent_name: "legacy" });
    const old = load_layered_config(work);
    expect(old?.config).toEqual({ agent_name: "legacy" });
    expect(old?.notes[0]).toContain(global_config_path());
    write_json(global_config_path(), { agent_name: "global" });
    const current = load_layered_config(work);
    expect(current?.config).toEqual({ agent_name: "global" });
    expect(current?.notes).toEqual([]);
  });

  it("does not merge ~/.lich/config.json over itself, or the legacy file under it, when the work_dir is home", () => {
    write_json(global_config_path(), { agent_name: "home" });
    write_json(path.join(home, ".config", "lich", "config.json"), { theme: "legacy" });
    const layered = load_layered_config(home);
    expect(layered?.config).toEqual({ agent_name: "home" });
    expect(layered?.sources).toEqual([global_config_path()]);
  });
});

describe("load_layered_config profiles", () => {
  let saved: { home?: string; profile?: string };
  let home: string;

  beforeEach(() => {
    saved = { home: process.env.HOME, profile: process.env.LICH_PROFILE };
    home = make_temp_dir("home");
    process.env.HOME = home;
    delete process.env.LICH_PROFILE;
  });

  afterEach(() => {
    for (const [key, value] of [["HOME", saved.home], ["LICH_PROFILE", saved.profile]] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  function write_file(file: string, body: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  }

  const profiles = (): string => path.join(home, ".lich", "profiles");

  it("merges global < profile < project, resolving profile plugin paths against ~/.lich/profiles", () => {
    const work = make_temp_dir("work");
    write_file(global_config_path(), JSON.stringify({ agent_name: "global", max_turns: 9, theme: "lich" }));
    write_file(path.join(profiles(), "coder.json"), JSON.stringify({ agent_name: "coder", max_turns: 5, plugins: ["p.mjs"] }));
    write_file(project_config_path(work), JSON.stringify({ max_turns: 2 }));
    const layered = load_layered_config(work, "coder");
    expect(layered?.config).toEqual({ agent_name: "coder", max_turns: 2, theme: "lich", plugins: [path.join(profiles(), "p.mjs")] });
    expect(layered?.profile).toBe("coder");
    expect(layered?.sources).toEqual([global_config_path(), path.join(profiles(), "coder.json"), project_config_path(work)]);
  });

  it("uses a non-empty soul as the system prompt, which a project system_prompt still overrides", () => {
    const work = make_temp_dir("work");
    write_file(path.join(profiles(), "bard.json"), JSON.stringify({ system_prompt: "from json" }));
    write_file(path.join(profiles(), "bard.md"), "  You are a bard.\n");
    expect(load_layered_config(work, "bard")?.config["system_prompt"]).toBe("You are a bard.");
    write_file(path.join(profiles(), "bard.md"), "   \n");
    expect(load_layered_config(work, "bard")?.config["system_prompt"]).toBe("from json");
    write_file(project_config_path(work), JSON.stringify({ system_prompt: "project" }));
    write_file(path.join(profiles(), "bard.md"), "You are a bard.");
    expect(load_layered_config(work, "bard")?.config["system_prompt"]).toBe("project");
  });

  it("picks the flag, then LICH_PROFILE, then the project profile key, then the global one, and drops the key", () => {
    const work = make_temp_dir("work");
    for (const name of ["a", "b", "c", "d"]) {
      write_file(path.join(profiles(), `${name}.json`), JSON.stringify({ agent_name: name }));
    }
    write_file(global_config_path(), JSON.stringify({ profile: "d" }));
    expect(load_layered_config(work)?.config).toEqual({ agent_name: "d" });
    write_file(project_config_path(work), JSON.stringify({ profile: "c" }));
    expect(load_layered_config(work)?.config).toEqual({ agent_name: "c" });
    process.env.LICH_PROFILE = "b";
    expect(load_layered_config(work)?.config).toEqual({ agent_name: "b" });
    expect(load_layered_config(work, "a")?.config).toEqual({ agent_name: "a" });
  });

  it("puts the profile over ~/.lich/config.json when the work_dir is home", () => {
    write_file(path.join(profiles(), "coder.json"), JSON.stringify({ agent_name: "coder" }));
    // Without ~/.lich/config.json the legacy file is still the base.
    write_file(path.join(home, ".config", "lich", "config.json"), JSON.stringify({ agent_name: "legacy", theme: "lich" }));
    expect(load_layered_config(home, "coder")?.config).toEqual({ agent_name: "coder", theme: "lich" });
    write_file(global_config_path(), JSON.stringify({ agent_name: "home", max_turns: 9 }));
    expect(load_layered_config(home, "coder")?.config).toEqual({ agent_name: "coder", max_turns: 9 });
  });

  it("throws for a missing profile or a name that is not a plain slug, without absolute paths", () => {
    const work = make_temp_dir("work");
    expect(() => load_layered_config(work, "ghost")).toThrow(/^profile not found: ghost$/);
    expect(() => load_layered_config(work, "../x")).toThrow("invalid profile name");
  });
});

describe("merge_config_layers", () => {
  const base_providers = [{ kind: "ollama", name: "a", model: "m" }];

  it("lets a project providers array replace the base's and drops the base models", () => {
    const merged = merge_config_layers(
      { providers: base_providers, models: { chat: ["a"] } },
      { providers: [{ kind: "ollama", name: "b", model: "n" }] },
    );
    expect(merged).toEqual({ providers: [{ kind: "ollama", name: "b", model: "n" }] });
  });

  it("keeps the base models when the project does not set providers, and project models when it does", () => {
    expect(merge_config_layers({ providers: base_providers, models: { chat: ["a"] } }, { max_turns: 2 })).toEqual({
      providers: base_providers,
      models: { chat: ["a"] },
      max_turns: 2,
    });
    expect(
      merge_config_layers({ models: { chat: ["a"] } }, { providers: base_providers, models: { compress: ["a"] } }),
    ).toEqual({ providers: base_providers, models: { compress: ["a"] } });
  });
});

describe("write_lich_config update", () => {
  it("replaces the file by rename instead of rewriting it in place, keeping its mode", () => {
    const dir = make_temp_dir("atomic");
    write_lich_config(dir, { version: 1 });
    const file = project_config_path(dir);
    chmodSync(file, 0o600);
    // A hard link shares the old inode: an in-place write would change it too.
    const old_inode = path.join(dir, "old-inode.json");
    linkSync(file, old_inode);
    const result = write_lich_config(dir, { version: 2 }, true);
    expect(result.written).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 2 });
    expect(JSON.parse(readFileSync(old_inode, "utf8"))).toEqual({ version: 1 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.dirname(file))).toEqual(["config.json"]);
  });
});

describe("integration shape", () => {
  it("uses test scratch space and never the os temp root", () => {
    expect(TEST_TMP_ROOT.startsWith(path.resolve("test/.tmp"))).toBe(true);
    expect(TEST_TMP_ROOT.startsWith(tmpdir())).toBe(false);
  });
});