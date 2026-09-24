/**
 * Validate Dockview `toJSON` payloads against currently registered pane ids.
 * Unknown / corrupt layouts fall back to the default plan.
 */

function is_plain_object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Array.isArray(value) === false;
}

/** Collect content component ids from a serialized Dockview layout. */
export function layout_component_ids(data: unknown): string[] | null {
  if (is_plain_object(data) === false) {
    return null;
  }
  if (is_plain_object(data.grid) === false || is_plain_object(data.panels) === false) {
    return null;
  }
  const ids: string[] = [];
  for (const [key, panel] of Object.entries(data.panels)) {
    if (is_plain_object(panel) === false) {
      return null;
    }
    const component =
      typeof panel.contentComponent === "string" ? panel.contentComponent : key;
    if (component.length === 0) {
      return null;
    }
    ids.push(component);
  }
  return ids;
}

/**
 * True when the payload looks like Dockview JSON and every panel component
 * maps to a registered contribution id (generic — no hardcoded pane names).
 */
export function can_restore_layout(
  data: unknown,
  registered_ids: ReadonlySet<string>,
): boolean {
  const ids = layout_component_ids(data);
  if (ids === null || ids.length === 0) {
    return false;
  }
  return ids.every((id) => registered_ids.has(id));
}

/** Registered contribution ids absent from a saved layout (null if corrupt). */
export function missing_registered_ids(
  data: unknown,
  registered_ids: ReadonlySet<string>,
): string[] | null {
  const ids = layout_component_ids(data);
  if (ids === null) {
    return null;
  }
  const saved = new Set(ids);
  return [...registered_ids].filter((id) => saved.has(id) === false);
}
