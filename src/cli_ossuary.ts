/**
 * `lich ossuary`: launch the Electron desktop shell when apps/ossuary is present.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MISSING_OSSUARY =
  "ossuary is not available in this install — clone https://github.com/Moikapy/lich and run from the repo (`bun src/cli.ts ossuary` or `bun run ossuary`)";

export type OssuaryRunner = (ossuary_dir: string, work_dir: string) => Promise<number>;

/** Package root from `src/cli.ts` or `dist/cli.js`. */
export function package_root_from_module_url(module_url: string): string {
  return path.dirname(path.dirname(fileURLToPath(module_url)));
}

/** Absolute `apps/ossuary` when that package exists under the lich root. */
export function resolve_ossuary_dir(package_root: string): string | undefined {
  const dir = path.join(package_root, "apps", "ossuary");
  return existsSync(path.join(dir, "package.json")) === true ? dir : undefined;
}

/** Run `bun run start` in apps/ossuary with LICH_WORK_DIR set. */
export function default_ossuary_runner(ossuary_dir: string, work_dir: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", "start"], {
      cwd: ossuary_dir,
      env: { ...process.env, LICH_WORK_DIR: work_dir },
      stdio: "inherit",
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      const hint =
        error.code === "ENOENT"
          ? "bun is not on PATH (required to launch apps/ossuary)"
          : error.message;
      process.stderr.write(`lich ossuary: ${hint}\n`);
      resolve(error.code === "ENOENT" ? 127 : 1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export async function run_ossuary(
  package_root: string,
  work_dir: string,
  runner: OssuaryRunner = default_ossuary_runner,
): Promise<number> {
  const ossuary_dir = resolve_ossuary_dir(package_root);
  if (ossuary_dir === undefined) {
    throw new Error(MISSING_OSSUARY);
  }
  return runner(ossuary_dir, path.resolve(work_dir));
}
