import type { ComponentType } from "react";

/** Default dock placement hints for pane contributions. */
export type PanePlacement = "main" | "left" | "right" | "bottom";

/** Contribution area name. Core starts with `"panes"` only. */
export type ContribArea = "panes" | (string & {});

export interface PaneContributionData {
  placement: PanePlacement;
}

/**
 * A registered UI contribution. Core and future plugins share this shape;
 * there is no disk plugin loader yet.
 */
export interface Contribution<TData = unknown> {
  id: string;
  area: ContribArea;
  title: string;
  data: TData;
  render: ComponentType;
}

export type PaneContribution = Contribution<PaneContributionData>;

/** Pane input without `area`; the registry pins it to `"panes"`. */
export type PaneContributionInput = Omit<PaneContribution, "area">;

/**
 * In-memory contribution registry. Registration rejects duplicate ids so
 * conflicting core/plugin panes fail loudly at startup.
 */
export class ContribRegistry {
  private readonly items = new Map<string, Contribution>();
  private readonly panes = new Map<string, PaneContribution>();

  register(contribution: Contribution): void {
    if (contribution.area === "panes") {
      throw new Error(`panes must register via register_pane(): ${contribution.id}`);
    }
    this.assert_new(contribution.id);
    this.items.set(contribution.id, contribution);
  }

  /** Typed pane path: pinning area and data here keeps `list_panes` cast-free. */
  register_pane(input: PaneContributionInput): void {
    const pane: PaneContribution = { ...input, area: "panes" };
    this.assert_new(pane.id);
    this.items.set(pane.id, pane);
    this.panes.set(pane.id, pane);
  }

  private assert_new(id: string): void {
    if (this.items.has(id)) {
      throw new Error(`duplicate_contribution: ${id}`);
    }
  }

  get(id: string): Contribution | undefined {
    return this.items.get(id);
  }

  /** Contributions for an area, in registration order. */
  list(area: ContribArea): Contribution[] {
    return [...this.items.values()].filter((item) => item.area === area);
  }

  /** Registered panes, in registration order. */
  list_panes(): PaneContribution[] {
    return [...this.panes.values()];
  }

  clear(): void {
    this.items.clear();
    this.panes.clear();
  }
}

/** Process-wide registry used by the ossuary shell. */
export const contrib_registry = new ContribRegistry();

export function register(contribution: Contribution): void {
  contrib_registry.register(contribution);
}

export function register_pane(input: PaneContributionInput): void {
  contrib_registry.register_pane(input);
}

export function list_by_area(area: ContribArea): Contribution[] {
  return contrib_registry.list(area);
}

export function list_panes(): PaneContribution[] {
  return contrib_registry.list_panes();
}
