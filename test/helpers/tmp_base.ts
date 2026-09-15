import { fileURLToPath } from "node:url";

/**
 * Absolute path to <repo>/test/.tmp, resolved from this module's URL so the
 * base stays correct regardless of the test runner's cwd (vitest run from the
 * repo root, or a bun test subprocess spawned from elsewhere).
 */
export const TMP_BASE = fileURLToPath(new URL("../.tmp", import.meta.url));