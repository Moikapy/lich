import { createElement, type FunctionComponent } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import type { PaneContribution, PanePlacement } from "../contrib/registry";

/** Dockview relative directions used when placing panes around main. */
export type DockDirection = "left" | "right" | "above" | "below" | "within";

export interface PlannedPanel {
  id: string;
  title: string;
  component: string;
  closable: boolean;
  position?: { referencePanel: string; direction: DockDirection };
}

const PLACEMENT_DIRECTION: Record<Exclude<PanePlacement, "main">, DockDirection> = {
  left: "left",
  right: "right",
  bottom: "below",
};

function is_closable(pane: PaneContribution): boolean {
  if (pane.data.closable === false) {
    return false;
  }
  if (pane.data.closable === true) {
    return true;
  }
  return pane.data.placement !== "main";
}

function sort_panes(panes: PaneContribution[]): PaneContribution[] {
  const mains = panes.filter((pane) => pane.data.placement === "main");
  const rest = panes.filter((pane) => pane.data.placement !== "main");
  return [...mains, ...rest];
}

/**
 * Build a default Dockview panel plan from registered pane contributions.
 * Main panes are added first; others dock relative to the first main id.
 */
export function plan_pane_layout(panes: PaneContribution[]): PlannedPanel[] {
  const ordered = sort_panes(panes);
  const main = ordered.find((pane) => pane.data.placement === "main") ?? ordered[0];
  if (!main) {
    return [];
  }

  return ordered.map((pane) => {
    const planned: PlannedPanel = {
      id: pane.id,
      title: pane.title,
      component: pane.id,
      closable: is_closable(pane),
    };
    if (pane.id !== main.id && pane.data.placement !== "main") {
      planned.position = {
        referencePanel: main.id,
        direction: PLACEMENT_DIRECTION[pane.data.placement],
      };
    }
    return planned;
  });
}

/** Map contribution ids to React panel components for DockviewReact. */
export function build_dock_components(
  panes: PaneContribution[],
): Record<string, FunctionComponent<IDockviewPanelProps>> {
  const components: Record<string, FunctionComponent<IDockviewPanelProps>> = {};
  for (const pane of panes) {
    const Pane = pane.render;
    components[pane.id] = function DockPane() {
      return createElement(Pane);
    };
  }
  return components;
}
