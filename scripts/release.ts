// scripts/release.ts — one-command release staging for lich.
//
// usage: bun release <patch|minor|major>
//
// bumps the version, runs pre-flight checks (clean tree, main branch,
// typecheck, tests), builds, packs + audits test/.tmp/lich-<version>.tgz,
// commits, tags v<version>, and pushes origin main. it never publishes —
// publishing stays interactive so npm can prompt for the OTP.

import { execFileSync, type StdioOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg_name = "@moikapy/lich";
const pkg_short = "lich";
const tar_dir = "test/.tmp";
const bump_kinds = ["patch", "minor", "major"] as const;
type bump_kind = (typeof bump_kinds)[number];

function log(message: string): void {
  console.log(`[release] ${message}`);
}

function fail(message: string): never {
  console.error(`\n[release] ✗ ${message}`);
  process.exit(1);
}

function usage_text(): string {
  return [
    "usage: bun release <patch|minor|major>",
    "",
    "stages a release: bumps the version, typechecks, runs the tests,",
    "builds, packs + audits test/.tmp/lich-<version>.tgz, commits, tags",
    "v<version>, and pushes origin main. publish stays manual:",
    "npm publish test/.tmp/lich-<version>.tgz",
  ].join("\n");
}

function cmd_error_detail(raw_error: unknown): string {
  if (raw_error instanceof Error) {
    const stdout = (raw_error as { stdout?: unknown }).stdout;
    const captured = typeof stdout === "string" ? stdout.trim() : "";
    return captured || raw_error.message;
  }
  return String(raw_error);
}

// run a command; stdio is live by default, stdout captured when `capture`.
function run_cmd(cmd: string, args: string[], capture = false): string {
  const stdio: StdioOptions = capture ? ["pipe", "pipe", "inherit"] : "inherit";
  try {
    const output = execFileSync(cmd, args, { stdio, encoding: "utf8" });
    return capture ? output.trim() : "";
  } catch (raw_error) {
    fail(`${cmd} ${args.join(" ")} failed:\n${cmd_error_detail(raw_error)}`);
  }
}

function read_pkg_version(): string {
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version?: string };
    if (typeof pkg.version === "string") return pkg.version;
  } catch {
    // fall through to the failure below
  }
  return fail("package.json is unreadable or missing its version field");
}

function version_parts(version: string): [number, number, number] {
  const core = version.replace(/^v/, "").split("-")[0]?.split("+")[0] ?? "";
  const parts = core.split(".");
  const valid = parts.length === 3 && parts.every((part) => /^\d+$/.test(part));
  if (!valid) fail(`cannot parse semver version "${version}"`);
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

function is_version_newer(next: string, prev: string): boolean {
  const [next_major, next_minor, next_patch] = version_parts(next);
  const [prev_major, prev_minor, prev_patch] = version_parts(prev);
  if (next_major !== prev_major) return next_major > prev_major;
  if (next_minor !== prev_minor) return next_minor > prev_minor;
  return next_patch > prev_patch;
}

function parse_bump_arg(argv: string[]): bump_kind {
  const args = argv.slice(2);
  const [arg] = args;
  if (arg === "--help" || arg === "-h") {
    console.log(usage_text());
    process.exit(0);
  }
  const kind = args.length === 1 ? bump_kinds.find((candidate) => candidate === arg) : undefined;
  if (kind === undefined) {
    fail(`expected exactly one of patch|minor|major, got: ${args.join(" ") || "(no arg)"}\n\n${usage_text()}`);
  }
  return kind;
}

// pre-flight: releases are built from committed state on main.
function ensure_clean_tree(): void {
  const status = run_cmd("git", ["status", "--porcelain"], true);
  if (status !== "") {
    fail(`working tree is not clean — commit or stash first:\n${status}`);
  }
}

function ensure_main_branch(): void {
  const branch = run_cmd("git", ["rev-parse", "--abbrev-ref", "HEAD"], true);
  if (branch !== "main") fail(`current branch is "${branch}" — releases are cut from main only`);
}

// package.json + bun.lock are the files npm version touches (bun.lock is
// tracked; version pins may update). bun.lock is optional for scratch setups.
function version_files(): string[] {
  return existsSync("bun.lock") ? ["package.json", "bun.lock"] : ["package.json"];
}

// bump via npm's own semver logic; the bump must strictly increase.
function bump_version(kind: bump_kind): string {
  const before = read_pkg_version();
  run_cmd("bun", ["x", "npm", "version", kind, "--no-git-tag-version"]);
  const after = read_pkg_version();
  if (!is_version_newer(after, before)) {
    run_cmd("git", ["checkout", "--", ...version_files()]);
    fail(`${kind} bump did not increase the version (${before} → ${after})`);
  }
  return after;
}

function commit_and_tag(version: string): void {
  run_cmd("git", ["add", ...version_files()]);
  run_cmd("git", ["commit", "-m", `chore(release): v${version}`]);
  run_cmd("git", ["tag", "-a", `v${version}`, "-m", `v${version}`]);
}

// pack into test/.tmp, then rename to the house lich-<version>.tgz
// convention (npm names scoped tarballs <scope>-<name>-<version>.tgz).
function pack_tarball(version: string): string {
  mkdirSync(tar_dir, { recursive: true });
  run_cmd("bun", ["x", "npm", "pack", "--pack-destination", tar_dir]);
  const npm_name = pkg_name.replace("@", "").replace("/", "-");
  const packed = `${tar_dir}/${npm_name}-${version}.tgz`;
  if (!existsSync(packed)) fail(`npm pack did not produce ${packed}`);
  const tarball = `${tar_dir}/${pkg_short}-${version}.tgz`;
  if (existsSync(tarball)) {
    fail(`${tarball} already exists — remove it (or pick a fresh version) before packing again`);
  }
  renameSync(packed, tarball);
  return tarball;
}

function format_bytes(size_bytes: number): string {
  if (size_bytes < 1024) return `${size_bytes} B`;
  const kb = size_bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(1)} kB` : `${(kb / 1024).toFixed(1)} MB`;
}

// print sha-512, size, and the file list for eyeballing.
function report_tarball(tarball: string): { sha512: string; size_bytes: number } {
  const bytes = readFileSync(tarball);
  const sha512 = createHash("sha512").update(bytes).digest("hex");
  log(`packed ${tarball}`);
  log(`sha-512: ${sha512}`);
  log(`size: ${format_bytes(bytes.byteLength)} (${bytes.byteLength} bytes)`);
  const listing = run_cmd("tar", ["-tzf", tarball], true);
  const entry_count = listing.split("\n").filter((line) => line !== "").length;
  log(`contents (${entry_count} entries):\n${listing}`);
  return { sha512, size_bytes: bytes.byteLength };
}

// scope verification: the tarball must ship @moikapy/lich@<version>.
export function audit_tarball(tarball: string, version: string): void {
  const raw = run_cmd("tar", ["-xzOf", tarball, "package/package.json"], true);
  let pkg: { name?: string; version?: string } = {};
  try {
    pkg = JSON.parse(raw) as { name?: string; version?: string };
  } catch {
    // fall through: a corrupt manifest fails the check below
  }
  if (pkg.name !== pkg_name || pkg.version !== version) {
    rmSync(tarball);
    fail(`audit failed: expected ${pkg_name}@${version} in the tarball, found ${String(pkg.name)}@${String(pkg.version)} — tarball deleted`);
  }
  log(`audit ok: tarball ships ${pkg_name}@${version}`);
}

function print_summary(version: string, tarball: string, sha512: string, size_bytes: number): void {
  console.log(`\n[release] release v${version} is staged`);
  console.log(`  version:  ${version}`);
  console.log(`  tarball:  ${tarball}`);
  console.log(`  sha-512:  ${sha512}`);
  console.log(`  size:     ${format_bytes(size_bytes)} (${size_bytes} bytes)`);
  console.log(`\nnext: npm publish ${tarball}`);
  console.log("      (publish stays interactive — npm will prompt for the OTP)");
}

function main(): void {
  const kind = parse_bump_arg(process.argv);
  log(`staging a ${kind} release of ${pkg_name}`);
  ensure_clean_tree();
  ensure_main_branch();
  log("running typecheck");
  run_cmd("bun", ["run", "typecheck"]);
  log("running tests");
  run_cmd("bun", ["run", "test"]);
  const version = bump_version(kind);
  log(`bumped to v${version}`);
  commit_and_tag(version);
  log("building dist");
  run_cmd("bun", ["run", "build"]);
  const tarball = pack_tarball(version);
  const { sha512, size_bytes } = report_tarball(tarball);
  audit_tarball(tarball, version);
  log("pushing main + tag to origin");
  run_cmd("git", ["push", "origin", "main", "--follow-tags"]);
  print_summary(version, tarball, sha512, size_bytes);
}

// entry guard: run main() only when executed directly (bun sets argv[1] to
// this file's path), so importing the module for testing is safe.
const is_entry = resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url));
if (is_entry) {
  process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  try {
    main();
  } catch (raw_error) {
    fail(String(raw_error));
  }
}