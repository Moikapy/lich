/**
 * CLI entry must run for Bun's bin (`import.meta.main`) and for Node's
 * symlink bin, and must stay quiet when this file is imported.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { is_cli_entry } from "../src/cli.js";
import { LICH_VERSION } from "../src/index.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const created: string[] = [];

function make_temp_dir(prefix: string): string {
  mkdirSync(TMP_BASE, { recursive: true });
  const dir = mkdtempSync(path.join(TMP_BASE, `${prefix}-`));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("is_cli_entry", () => {
  it("runs under bun when import.meta.main is true, even if argv does not match", () => {
    expect(
      is_cli_entry({
        bun: true,
        import_meta_main: true,
        module_url: "file:///pkg/dist/cli.js",
        argv1: undefined,
      }),
    ).toBe(true);
  });

  it("does not run under bun when the file is imported", () => {
    expect(
      is_cli_entry({
        bun: true,
        import_meta_main: false,
        module_url: "file:///pkg/dist/cli.js",
        argv1: "/pkg/dist/cli.js",
      }),
    ).toBe(false);
  });

  it("does not treat a missing bun entry signal as the main module", () => {
    expect(
      is_cli_entry({
        bun: true,
        import_meta_main: undefined,
        module_url: "file:///pkg/dist/cli.js",
        argv1: "/pkg/dist/cli.js",
      }),
    ).toBe(false);
  });

  it("node fallback matches a direct file and a global bin symlink", () => {
    const root = make_temp_dir("cli-entry");
    const cli_path = path.join(root, "pkg", "dist", "cli.js");
    const bin_path = path.join(root, "bin", "lich");
    mkdirSync(path.dirname(cli_path), { recursive: true });
    mkdirSync(path.dirname(bin_path), { recursive: true });
    writeFileSync(cli_path, "#!/usr/bin/env node\n");
    symlinkSync(path.relative(path.dirname(bin_path), cli_path), bin_path);
    const module_url = pathToFileURL(cli_path).href;

    expect(is_cli_entry({ bun: false, import_meta_main: undefined, module_url, argv1: cli_path })).toBe(true);
    expect(is_cli_entry({ bun: false, import_meta_main: undefined, module_url, argv1: bin_path })).toBe(true);
    expect(module_url === pathToFileURL(path.resolve(bin_path)).href).toBe(false);
  });

  it("node fallback stays false when another script imported this file", () => {
    const root = make_temp_dir("cli-import");
    const cli_path = path.join(root, "cli.js");
    const other_path = path.join(root, "vitest.mjs");
    writeFileSync(cli_path, "");
    writeFileSync(other_path, "");

    expect(
      is_cli_entry({
        bun: false,
        import_meta_main: undefined,
        module_url: pathToFileURL(cli_path).href,
        argv1: other_path,
      }),
    ).toBe(false);
    expect(
      is_cli_entry({
        bun: false,
        import_meta_main: undefined,
        module_url: pathToFileURL(cli_path).href,
        argv1: undefined,
      }),
    ).toBe(false);
  });
});

describe("LICH_VERSION", () => {
  it("matches package.json so update does not reinstall a stale constant", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(LICH_VERSION).toBe(pkg.version);
  });
});
