/**
 * Unit tests for CLI config-file discovery: search chain, explicit paths,
 * safe JSON loading, and the starter template printed by `lich config`.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { config_search_paths, config_template, ensure_lich_config_dir, find_config_file, load_config } from "../src/cli_config.js";

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
  it("lists the cwd .lich config first and the user config home second", () => {
    const paths = config_search_paths();
    expect(paths[0]).toBe(path.resolve(process.cwd(), ".lich/config.json"));
    expect(paths[1]).toBe(path.resolve(homedir(), ".config/lich/config.json"));
  });

  it("resolves the first entry from the requested work_dir", () => {
    const paths = config_search_paths("/some/work/dir");
    expect(paths[0]).toBe("/some/work/dir/.lich/config.json");
  });

  it("keeps both entries ordered for a work_dir inside the config home", () => {
    const paths = config_search_paths(path.join(homedir(), ".config/lich"));
    expect(paths[0]).toBe(path.resolve(homedir(), ".config/lich/.lich/config.json"));
    expect(paths[1]).toBe(path.resolve(homedir(), ".config/lich/config.json"));
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
    });
  });

  it("honors LICH_MODEL in the generated template", () => {
    with_env_vars({ LICH_MODEL: "test-model", LICH_PROVIDER_KIND: undefined }, () => {
      const template = JSON.parse(config_template()) as { providers: Array<Record<string, unknown>> };
      expect(template.providers[0]?.["model"]).toBe("test-model");
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

describe("integration shape", () => {
  it("uses test scratch space and never the os temp root", () => {
    expect(TEST_TMP_ROOT.startsWith(path.resolve("test/.tmp"))).toBe(true);
    expect(TEST_TMP_ROOT.startsWith(tmpdir())).toBe(false);
  });
});