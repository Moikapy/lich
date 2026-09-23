/**
 * Package version shared by CLI, TUI, and serve (avoids circular imports).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function read_package_version(): string {
  const pkg_path = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(readFileSync(pkg_path, "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error("package.json is missing version");
  }
  return pkg.version;
}

export const LICH_VERSION = read_package_version();
