/**
 * Must-fix tools: symlink escape, forbidden paths, SSRF, run_tests filter, env scrub.
 */
import { mkdir, mkdtemp, symlink, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assert_file_tool_access, resolve_safe_path } from "../src/tools/guard.js";
import { is_blocked_ip, private_urls_allowed, resolve_public_ip } from "../src/tools/url_guard.js";
import { scrub_spawn_env } from "../src/tools/builtin/terminal.js";
import { run_tests_tool, set_test_command_runner, reset_test_command_runner } from "../src/tools/builtin/run_tests.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const temp_dirs: string[] = [];

afterAll(async () => {
  for (const dir of temp_dirs) {
    await rm(dir, { recursive: true, force: true });
  }
  reset_test_command_runner();
});

async function make_temp_dir(): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(path.join(TMP_BASE, "tools-review-"));
  temp_dirs.push(dir);
  return dir;
}

describe("S-1 resolve_safe_path symlink escape", () => {
  it("rejects a symlink that points outside work_dir", async () => {
    const work = await make_temp_dir();
    const outside = await make_temp_dir();
    await writeFile(path.join(outside, "secret.txt"), "nope");
    await symlink(path.join(outside, "secret.txt"), path.join(work, "link.txt"));
    expect(() => resolve_safe_path(work, "link.txt")).toThrow(/path_escape/);
  });

  it("rejects writing through a symlink leaf", async () => {
    const work = await make_temp_dir();
    const outside = await make_temp_dir();
    await writeFile(path.join(outside, "target.txt"), "x");
    await symlink(path.join(outside, "target.txt"), path.join(work, "out.txt"));
    expect(() => resolve_safe_path(work, "out.txt", true)).toThrow(/path_escape/);
  });
});

describe("S-3 forbidden paths", () => {
  it("denies .lich/config.json and .env writes", async () => {
    const work = await make_temp_dir();
    await mkdir(path.join(work, ".lich"), { recursive: true });
    await writeFile(path.join(work, ".lich", "config.json"), "{}");
    const config_path = resolve_safe_path(work, ".lich/config.json");
    expect(() => assert_file_tool_access(work, config_path, "read")).toThrow(/forbidden_path/);
    const env_path = path.join(work, ".env");
    await writeFile(env_path, "x=1");
    const resolved_env = resolve_safe_path(work, ".env", true);
    expect(() => assert_file_tool_access(work, resolved_env, "write")).toThrow(/forbidden_path/);
  });
});

describe("S-2 SSRF helpers", () => {
  it("blocks loopback and private IPs unless opted out", () => {
    expect(is_blocked_ip("127.0.0.1")).toBe(true);
    expect(is_blocked_ip("10.0.0.1")).toBe(true);
    expect(is_blocked_ip("169.254.169.254")).toBe(true);
    expect(is_blocked_ip("8.8.8.8")).toBe(false);
  });

  it("rejects localhost resolution when private URLs are disallowed", async () => {
    if (private_urls_allowed() === true) {
      return;
    }
    await expect(resolve_public_ip("localhost")).rejects.toThrow(/blocked_url/);
  });
});

describe("S-4 terminal env scrub", () => {
  it("drops secret-named and gateway token envs", () => {
    const scrubbed = scrub_spawn_env(
      {
        PATH: "/usr/bin",
        OPENAI_API_KEY: "sk-test",
        LICH_GATEWAY_TOKEN: "tok",
        SAFE_VALUE: "ok",
      },
      { MY_SECRET: "nope", HOME: "/tmp" },
    );
    expect(scrubbed.PATH).toBe("/usr/bin");
    expect(scrubbed.SAFE_VALUE).toBe("ok");
    expect(scrubbed.HOME).toBe("/tmp");
    expect(scrubbed.OPENAI_API_KEY).toBeUndefined();
    expect(scrubbed.LICH_GATEWAY_TOKEN).toBeUndefined();
    expect(scrubbed.MY_SECRET).toBeUndefined();
  });
});

describe("S-5 run_tests filter gate", () => {
  it("rejects filters that start with -", async () => {
    const work = await make_temp_dir();
    set_test_command_runner(async () => ({ exit_code: 0 }));
    const result = await run_tests_tool.execute({ filter: "--help" }, { work_dir: work, env: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/invalid_filter/);
  });
});
