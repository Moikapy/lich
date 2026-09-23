import {
  DockviewDefaultTab,
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import type { PaneContribution } from "../contrib/registry";
import { build_dock_components, plan_pane_layout } from "./pane_layout";

const UNCLOSEABLE_TAB = "uncloseable";

function UncloseableTab(props: IDockviewPanelHeaderProps) {
  return <DockviewDefaultTab {...props} hideClose />;
}

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
  const components = build_dock_components(panes);

  return (
    <DockviewReact
      className="dockview-theme-abyss ossuary-dock"
      components={components}
      tabComponents={{ [UNCLOSEABLE_TAB]: UncloseableTab }}
      onReady={(event) => apply_default_layout(event, panes)}
    />
  );
}
