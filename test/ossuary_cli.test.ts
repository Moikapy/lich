/**
 * CLI `lich ossuary`: resolve apps/ossuary, help text, and runner wiring.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse_args, run_cli } from "../src/cli.js";
import {
  package_root_from_module_url,
  resolve_ossuary_dir,
  run_ossuary,
} from "../src/cli_ossuary.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const created: string[] = [];

async function make_temp_dir(prefix: string): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(path.join(TMP_BASE, `${prefix}-`));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("resolve_ossuary_dir", () => {
  it("returns apps/ossuary when package.json exists", async () => {
    const root = await make_temp_dir("ossuary-present");
    const ossuary = path.join(root, "apps", "ossuary");
    await mkdir(ossuary, { recursive: true });
    await writeFile(path.join(ossuary, "package.json"), JSON.stringify({ name: "@moikapy/ossuary" }));
    expect(resolve_ossuary_dir(root)).toBe(ossuary);
  });

  it("returns undefined when apps/ossuary is missing", async () => {
    const root = await make_temp_dir("ossuary-absent");
    expect(resolve_ossuary_dir(root)).toBeUndefined();
  });
});

describe("run_ossuary", () => {
  it("throws when ossuary is not in the package tree", async () => {
    const root = await make_temp_dir("ossuary-missing-run");
    await expect(run_ossuary(root, root)).rejects.toThrow(/ossuary is not available/);
  });

  it("passes ossuary dir and work_dir to the runner", async () => {
    const root = await make_temp_dir("ossuary-run");
    const ossuary = path.join(root, "apps", "ossuary");
    await mkdir(ossuary, { recursive: true });
    await writeFile(path.join(ossuary, "package.json"), "{}");
    const work_dir = path.join(root, "project");
    const runner = vi.fn(async () => 0);
    expect(await run_ossuary(root, work_dir, runner)).toBe(0);
    expect(runner).toHaveBeenCalledWith(ossuary, work_dir);
  });
});

describe("package_root_from_module_url", () => {
  it("strips src/ or dist/ from the cli module path", () => {
    const src_cli = pathToFileURL(path.join("/tmp/lich", "src", "cli.ts")).href;
    expect(package_root_from_module_url(src_cli)).toBe(path.join("/tmp/lich"));
    const dist_cli = pathToFileURL(path.join("/tmp/lich", "dist", "cli.js")).href;
    expect(package_root_from_module_url(dist_cli)).toBe(path.join("/tmp/lich"));
  });
});

describe("run_cli ossuary wiring", () => {
  it("lists ossuary in --help", async () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await run_cli(["--help"])).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(chunks.join("")).toMatch(/lich ossuary/);
  });

  it("rejects extra arguments", async () => {
    await expect(run_cli(["ossuary", "extra"])).rejects.toThrow("ossuary takes no arguments");
  });

  it("rejects --resume outside TUI", async () => {
    await expect(run_cli(["ossuary", "--resume", "latest"])).rejects.toThrow(
      "--resume is only supported in TUI mode (not ossuary)",
    );
  });

  it("parses ossuary as a positional with --work-dir", () => {
    const options = parse_args(["ossuary", "--work-dir", "/tmp/project"]);
    expect(options.positionals).toEqual(["ossuary"]);
    expect(options.overrides["work_dir"]).toBe("/tmp/project");
  });
});
