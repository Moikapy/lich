#!/usr/bin/env node
/**
 * Electron's install.js uses extract-zip, which hangs on Node 26+.
 * Download the artifact (or reuse cache), then unzip with the system tool.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electron_dir = path.join(root, "node_modules/electron");
const dist_dir = path.join(electron_dir, "dist");
const path_txt = path.join(electron_dir, "path.txt");

/** Match electron's install.js getPlatformPath(). */
const platform_path =
  (
    {
      darwin: "Electron.app/Contents/MacOS/Electron",
      mas: "Electron.app/Contents/MacOS/Electron",
      win32: "electron.exe",
    } as Record<string, string>
  )[process.platform] ?? "electron";

const electron_bin = path.join(dist_dir, platform_path);

if (fs.existsSync(electron_bin)) {
  const existing = fs.existsSync(path_txt)
    ? fs.readFileSync(path_txt, "utf8").trim()
    : "";
  if (existing !== platform_path) {
    fs.writeFileSync(path_txt, platform_path);
  }
  process.exit(0);
}

if (!fs.existsSync(electron_dir)) {
  console.error("ensure_electron: electron package missing; run bun install first");
  process.exit(1);
}

const { downloadArtifact } = require("@electron/get");
const { version } = require(path.join(electron_dir, "package.json"));
const checksums = require(path.join(electron_dir, "checksums.json"));

const zip_path = await downloadArtifact({
  version,
  artifactName: "electron",
  platform: process.platform,
  arch: process.arch,
  checksums,
});

fs.rmSync(dist_dir, { recursive: true, force: true });
fs.mkdirSync(dist_dir, { recursive: true });

const unzip = spawnSync("unzip", ["-o", zip_path, "-d", dist_dir], {
  stdio: "inherit",
});

if (unzip.error) {
  const err = unzip.error as NodeJS.ErrnoException;
  if (err.code === "ENOENT") {
    console.error(
      "ensure_electron: system `unzip` not found; install it (e.g. apt install unzip / brew install unzip) and retry",
    );
  } else {
    console.error(`ensure_electron: unzip failed: ${err.message}`);
  }
  process.exit(1);
}

if (unzip.status !== 0) {
  console.error("ensure_electron: unzip failed");
  process.exit(unzip.status ?? 1);
}

if (!fs.existsSync(electron_bin)) {
  console.error(
    `ensure_electron: electron binary missing after unzip (expected ${platform_path})`,
  );
  process.exit(1);
}

fs.writeFileSync(path_txt, platform_path);
console.log(`ensure_electron: ready (${version})`);
