/** Preload bridge helpers for Dockview layout persistence (no Node in renderer). */

export async function load_persisted_layout(): Promise<unknown | null> {
  const api = window.ossuary;
  if (api?.loadLayout === undefined) {
    return null;
  }
  return api.loadLayout();
}

export async function save_persisted_layout(layout: unknown): Promise<void> {
  const api = window.ossuary;
  if (api?.saveLayout === undefined) {
    return;
  }
  await api.saveLayout(layout);
}
