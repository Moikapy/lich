/**
 * Must-fix tools: symlink escape, forbidden paths, SSRF, run_tests filter, env scrub.
 */
import dns from "node:dns/promises";
import { mkdir, mkdtemp, symlink, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { assert_file_tool_access, resolve_safe_path } from "../src/tools/guard.js";
import {
  is_blocked_ip,
  private_urls_allowed,
  reset_url_guard_fetch,
  resolve_public_ip,
  safe_fetch,
  set_url_guard_fetch,
} from "../src/tools/url_guard.js";
import { scrub_spawn_env } from "../src/tools/builtin/terminal.js";
import { grep_files_tool } from "../src/tools/builtin/grep_files.js";
import { run_tests_tool, set_test_command_runner, reset_test_command_runner } from "../src/tools/builtin/run_tests.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const temp_dirs: string[] = [];

afterAll(async () => {
  for (const dir of temp_dirs) {
    await rm(dir, { recursive: true, force: true });
  }
  reset_test_command_runner();
});

afterEach(() => {
  reset_url_guard_fetch();
});

function restore_private_url_env(saved: string | undefined): void {
  if (saved === undefined) {
    delete process.env["LICH_ALLOW_PRIVATE_URLS"];
    return;
  }
  process.env["LICH_ALLOW_PRIVATE_URLS"] = saved;
}

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

  it("blocks CGNAT, shared-space, multicast, and IPv4-mapped loopback", () => {
    const blocked = [
      "0.0.0.0",
      "172.16.0.1",
      "172.31.255.255",
      "100.64.0.1",
      "100.127.255.255",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:10.1.2.3",
      "::ffff:169.254.169.254",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "not-an-ip",
    ];
    for (const address of blocked) {
      expect(is_blocked_ip(address), address).toBe(true);
    }
    const public_addrs = ["172.15.255.255", "172.32.0.1", "100.63.0.1", "100.128.0.1", "223.0.0.1", "::ffff:8.8.8.8", "2001:4860:4860::8888"];
    for (const address of public_addrs) {
      expect(is_blocked_ip(address), address).toBe(false);
    }
  });

  it("rejects mapped loopback and CGNAT literals before DNS", async () => {
    if (private_urls_allowed() === true) {
      return;
    }
    await expect(resolve_public_ip("::ffff:127.0.0.1")).rejects.toThrow(/blocked_url/);
    await expect(resolve_public_ip("100.64.0.1")).rejects.toThrow(/blocked_url/);
    await expect(resolve_public_ip("172.16.0.1")).rejects.toThrow(/blocked_url/);
    await expect(resolve_public_ip("8.8.8.8")).resolves.toBe("8.8.8.8");
  });

  it("rejects localhost resolution when private URLs are disallowed", async () => {
    if (private_urls_allowed() === true) {
      return;
    }
    await expect(resolve_public_ip("localhost")).rejects.toThrow(/blocked_url/);
  });

  it("rejects bracketed IPv6 loopback hostnames from URL.hostname", async () => {
    if (private_urls_allowed() === true) {
      return;
    }
    await expect(resolve_public_ip("[::1]")).rejects.toThrow(/blocked_url/);
  });

  it("rejects a host when any DNS answer is private, and local suffixes before lookup", async () => {
    const saved = process.env["LICH_ALLOW_PRIVATE_URLS"];
    delete process.env["LICH_ALLOW_PRIVATE_URLS"];
    const lookup = vi.spyOn(dns, "lookup");
    try {
      lookup.mockImplementation(async () => [{ address: "1.1.1.1", family: 4 }] as never);
      await expect(resolve_public_ip("cdn.example")).resolves.toBe("1.1.1.1");
      lookup.mockImplementation(async () => [
        { address: "1.1.1.1", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ] as never);
      await expect(resolve_public_ip("cdn.example")).rejects.toThrow(/blocked_url: cdn\.example/);
      lookup.mockImplementation(async () => [] as never);
      await expect(resolve_public_ip("cdn.example")).rejects.toThrow(/blocked_url: cdn\.example/);
      lookup.mockClear();
      await expect(resolve_public_ip("app.localhost")).rejects.toThrow(/blocked_url: app\.localhost/);
      await expect(resolve_public_ip("printer.local")).rejects.toThrow(/blocked_url: printer\.local/);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
      restore_private_url_env(saved);
    }
  });

  it("allows a private literal only when LICH_ALLOW_PRIVATE_URLS is exactly 1", async () => {
    const saved = process.env["LICH_ALLOW_PRIVATE_URLS"];
    try {
      process.env["LICH_ALLOW_PRIVATE_URLS"] = "true";
      await expect(resolve_public_ip("127.0.0.1")).rejects.toThrow(/blocked_url/);
      process.env["LICH_ALLOW_PRIVATE_URLS"] = "1";
      await expect(resolve_public_ip("127.0.0.1")).resolves.toBe("127.0.0.1");
    } finally {
      restore_private_url_env(saved);
    }
  });

  it("safe_fetch keeps https hostname for the fetch seam (no IP rewrite)", async () => {
    const seen: string[] = [];
    set_url_guard_fetch(async (input) => {
      seen.push(String(input));
      return new Response("ok", { status: 200 });
    });
    const response = await safe_fetch("https://example.com/path");
    expect(response.status).toBe(200);
    expect(seen).toEqual(["https://example.com/path"]);
  });
});

describe("S-1/S-3 grep_files guards", () => {
  it("does not follow a symlink file out of work_dir", async () => {
    const work = await make_temp_dir();
    const outside = await make_temp_dir();
    await mkdir(path.join(work, "w"), { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "outside_secret_marker");
    await symlink(path.join(outside, "secret.txt"), path.join(work, "w", "link.txt"));
    await writeFile(path.join(work, "w", "ok.txt"), "inside_ok");
    const result = await grep_files_tool.execute(
      { pattern: "outside_secret_marker|inside_ok", path: "w" },
      { work_dir: work, env: {} },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("inside_ok");
    expect(result.output).not.toContain("outside_secret_marker");
  });

  it("denies grepping .lich/config.json and does not leak api_key from .lich", async () => {
    const work = await make_temp_dir();
    await mkdir(path.join(work, ".lich"), { recursive: true });
    await writeFile(path.join(work, ".lich", "config.json"), '{"api_key":"sk-test-secret"}');
    const direct = await grep_files_tool.execute(
      { pattern: "api_key", path: ".lich/config.json" },
      { work_dir: work, env: {} },
    );
    expect(direct.ok).toBe(false);
    expect(direct.error).toMatch(/forbidden_path/);
    const dir = await grep_files_tool.execute({ pattern: "api_key", path: ".lich" }, { work_dir: work, env: {} });
    expect(dir.ok).toBe(true);
    expect(dir.output).not.toContain("api_key");
    expect(dir.output).not.toContain("sk-test-secret");
  });

  it("denies grepping .lich/profiles and still searches the rest of .lich", async () => {
    const work = await make_temp_dir();
    await mkdir(path.join(work, ".lich", "profiles"), { recursive: true });
    await mkdir(path.join(work, ".lich", "skills"), { recursive: true });
    await writeFile(path.join(work, ".lich", "profiles", "coder.md"), "profile-soul-secret\n");
    await writeFile(path.join(work, ".lich", "skills", "note.md"), "skill-marker\n");
    const direct = await grep_files_tool.execute(
      { pattern: "profile-soul-secret", path: ".lich/profiles/coder.md" },
      { work_dir: work, env: {} },
    );
    expect(direct.ok).toBe(false);
    expect(direct.error).toMatch(/forbidden_path: \.lich\/profiles/);
    expect(direct.output).not.toContain("profile-soul-secret");
    const root = await grep_files_tool.execute(
      { pattern: "profile-soul-secret", path: ".lich/profiles" },
      { work_dir: work, env: {} },
    );
    expect(root.ok).toBe(false);
    expect(root.error).toMatch(/forbidden_path: \.lich\/profiles/);
    const walked = await grep_files_tool.execute(
      { pattern: "profile-soul-secret|skill-marker", path: ".lich" },
      { work_dir: work, env: {} },
    );
    expect(walked.ok).toBe(true);
    expect(walked.output).toContain("skill-marker");
    expect(walked.output).not.toContain("profile-soul-secret");
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

  it("does not let the tool context put secret names back into the spawn env", () => {
    const scrubbed = scrub_spawn_env(
      { PATH: "/usr/bin" },
      {
        PATH: "/opt/bin",
        ANTHROPIC_API_KEY: "sk-ant",
        LICH_API_KEY: "lich-key",
        LICH_DISCORD_BOT_TOKEN: "discord",
        LICH_TELEGRAM_BOT_TOKEN: "telegram",
        LICH_TWITCH_OAUTH_TOKEN: "twitch",
        VISIBLE: "kept",
      },
    );
    expect(scrubbed.PATH).toBe("/opt/bin");
    expect(scrubbed.VISIBLE).toBe("kept");
    expect(scrubbed.ANTHROPIC_API_KEY).toBeUndefined();
    expect(scrubbed.LICH_API_KEY).toBeUndefined();
    expect(scrubbed.LICH_DISCORD_BOT_TOKEN).toBeUndefined();
    expect(scrubbed.LICH_TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(scrubbed.LICH_TWITCH_OAUTH_TOKEN).toBeUndefined();
  });

  it("drops pattern-matched secrets, skips unset values, and keeps an empty string", () => {
    const scrubbed = scrub_spawn_env(
      { PATH: "/usr/bin", OPTIONAL: undefined, EMPTY: "", Api_Key: "mixed" },
      { GITHUB_TOKEN: "ghp-test", AWS_SECRET_ACCESS_KEY: "aws-test", VISIBLE: "kept" },
    );
    expect(scrubbed.PATH).toBe("/usr/bin");
    expect(scrubbed.EMPTY).toBe("");
    expect(scrubbed.VISIBLE).toBe("kept");
    expect(scrubbed.OPTIONAL).toBeUndefined();
    expect(scrubbed.Api_Key).toBeUndefined();
    expect(scrubbed.GITHUB_TOKEN).toBeUndefined();
    expect(scrubbed.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(Object.values(scrubbed).join(" ")).not.toContain("ghp-test");
    expect(Object.values(scrubbed).join(" ")).not.toContain("aws-test");
    expect(Object.values(scrubbed).join(" ")).not.toContain("mixed");
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
