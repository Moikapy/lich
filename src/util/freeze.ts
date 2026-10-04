/** Recursively freeze plain objects and arrays in place. */
export function deep_freeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value) === true) {
    return;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deep_freeze(child);
  }
}
