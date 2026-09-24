import {
  DockviewDefaultTab,
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { useMemo } from "react";
import type { PaneContribution } from "../contrib/registry";
import { build_dock_components, plan_pane_layout } from "./pane_layout";

const UNCLOSEABLE_TAB = "uncloseable";

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

export interface DockShellProps {
  panes: PaneContribution[];
}

/** Dockview host that mounts registered `panes` contributions. */
export function DockShell({ panes }: DockShellProps) {
  const components = useMemo(() => build_dock_components(panes), [panes]);

  return (
    <DockviewReact
      className="dockview-theme-abyss ossuary-dock"
      components={components}
      tabComponents={TAB_COMPONENTS}
      onReady={(event) => apply_default_layout(event, panes)}
    />
  );
}
