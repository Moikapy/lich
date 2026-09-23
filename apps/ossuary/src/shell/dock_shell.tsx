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
import { can_restore_layout } from "./layout_persist";
import { build_dock_components, plan_pane_layout } from "./pane_layout";

const UNCLOSEABLE_TAB = "uncloseable";
const SAVE_DEBOUNCE_MS = 250;

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

function restore_or_default(
  event: DockviewReadyEvent,
  panes: PaneContribution[],
  saved: unknown,
): void {
  const registered = new Set(panes.map((pane) => pane.id));
  if (can_restore_layout(saved, registered)) {
    try {
      event.api.fromJSON(saved as Parameters<typeof event.api.fromJSON>[0]);
      return;
    } catch {
      // corrupt / incompatible → default
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

  useEffect(() => {
    return () => {
      cleanup_ref.current?.();
      cleanup_ref.current = undefined;
    };
  }, []);

  const on_ready = useCallback((event: DockviewReadyEvent) => {
    cleanup_ref.current?.();
    void (async () => {
      const saved = await load_persisted_layout();
      restore_or_default(event, panes_ref.current, saved);

      let timer: ReturnType<typeof setTimeout> | undefined;
      const disposable = event.api.onDidLayoutChange(() => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        timer = setTimeout(() => {
          void save_persisted_layout(event.api.toJSON());
        }, SAVE_DEBOUNCE_MS);
      });

      cleanup_ref.current = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        disposable.dispose();
      };
    })();
  }, []);

  return (
    <DockviewReact
      className="dockview-theme-abyss ossuary-dock"
      components={components}
      tabComponents={TAB_COMPONENTS}
      onReady={on_ready}
    />
  );
}
