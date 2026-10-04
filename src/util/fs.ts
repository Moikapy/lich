/** Shared fs predicates (single definition; no recursion, no state). */

/** True when `error` is a Node fs ENOENT (missing file/directory). */
export function is_enoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}