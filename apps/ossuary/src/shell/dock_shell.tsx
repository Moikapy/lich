import {
  DockviewDefaultTab,
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { PaneContribution } from "../contrib/registry";
import { load_persisted_layout, save_persisted_layout } from "./layout_bridge";
import { can_restore_layout, missing_registered_ids } from "./layout_persist";
import { build_dock_components, plan_pane_layout } from "./pane_layout";

const UNCLOSEABLE_TAB = "uncloseable";
const SAVE_DEBOUNCE_MS = 250;
/** Same-origin blank page for Dockview OS-window popouts (#93). */
const POPOUT_URL = "/popout.html";

function UncloseableTab(props: IDockviewPanelHeaderProps) {
  return <DockviewDefaultTab {...props} hideClose />;
}

const TAB_COMPONENTS = { [UNCLOSEABLE_TAB]: UncloseableTab };

function apply_default_layout(
  event: DockviewReadyEvent,
  panes: PaneContribution[],
): void {
  const planned = plan_pane_layout(panes);
  for (const panel of planned) {
    event.api.addPanel({
      id: panel.id,
      component: panel.component,
      title: panel.title,
      tabComponent: panel.closable ? undefined : UNCLOSEABLE_TAB,
      position: panel.position,
    });
  }
}

function add_missing_panels(
  event: DockviewReadyEvent,
  panes: PaneContribution[],
  missing_ids: readonly string[],
): void {
  if (missing_ids.length === 0) {
    return;
  }
  const missing = new Set(missing_ids);
  const planned = plan_pane_layout(panes);
  for (const panel of planned) {
    if (missing.has(panel.id) === false) {
      continue;
    }
    event.api.addPanel({
      id: panel.id,
      component: panel.component,
      title: panel.title,
      tabComponent: panel.closable ? undefined : UNCLOSEABLE_TAB,
      position: panel.position,
    });
  }
}

async function restore_or_default(
  event: DockviewReadyEvent,
  panes: PaneContribution[],
  saved: unknown,
): Promise<void> {
  const registered = new Set(panes.map((pane) => pane.id));
  if (can_restore_layout(saved, registered)) {
    try {
      event.api.fromJSON(saved as Parameters<typeof event.api.fromJSON>[0]);
      await event.api.popoutRestorationPromise;
      const missing = missing_registered_ids(saved, registered) ?? [];
      add_missing_panels(event, panes, missing);
      return;
    } catch {
      // corrupt / incompatible → default
      try {
        event.api.clear();
      } catch {
        // disposed
      }
      apply_default_layout(event, panes);
      return;
    }
  }
  apply_default_layout(event, panes);
}

export interface DockShellProps {
  panes: PaneContribution[];
}

/** Dockview host that mounts registered `panes` contributions. */
export function DockShell({ panes }: DockShellProps) {
  const components = useMemo(() => build_dock_components(panes), [panes]);
  const panes_ref = useRef(panes);
  panes_ref.current = panes;
  const cleanup_ref = useRef<(() => void) | undefined>(undefined);
  const generation_ref = useRef(0);

  useEffect(() => {
    return () => {
      cleanup_ref.current?.();
      cleanup_ref.current = undefined;
    };
  }, []);

  const on_ready = useCallback((event: DockviewReadyEvent) => {
    cleanup_ref.current?.();
    const generation = ++generation_ref.current;
    void (async () => {
      try {
        const saved = await load_persisted_layout();
        if (generation !== generation_ref.current) {
          return;
        }
        await restore_or_default(event, panes_ref.current, saved);
        if (generation !== generation_ref.current) {
          return;
        }

        let timer: ReturnType<typeof setTimeout> | undefined;
        const flush = (): void => {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          void save_persisted_layout(event.api.toJSON()).catch((error: unknown) => {
            console.warn("ossuary layout save failed", error);
          });
        };
        const disposable = event.api.onDidLayoutChange(() => {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
        });
        const on_unload = (): void => {
          flush();
        };
        window.addEventListener("beforeunload", on_unload);

        cleanup_ref.current = () => {
          window.removeEventListener("beforeunload", on_unload);
          flush();
          disposable.dispose();
        };
      } catch (error: unknown) {
        if (generation !== generation_ref.current) {
          return;
        }
        console.warn("ossuary layout restore failed", error);
        try {
          apply_default_layout(event, panes_ref.current);
        } catch {
          // disposed api — ignore
        }
      }
    })();
  }, []);

  return (
    <DockviewReact
      className="dockview-theme-abyss ossuary-dock"
      components={components}
      tabComponents={TAB_COMPONENTS}
      popoutUrl={POPOUT_URL}
      getTabContextMenuItems={() => ["popout", "float", "separator", "maximize"]}
      onReady={on_ready}
    />
  );
}
