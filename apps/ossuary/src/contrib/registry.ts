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

/**
 * In-memory contribution registry. Registration rejects duplicate ids so
 * conflicting core/plugin panes fail loudly at startup.
 */
export class ContribRegistry {
  private readonly items = new Map<string, Contribution>();

  register(contribution: Contribution): void {
    if (this.items.has(contribution.id)) {
      throw new Error(`duplicate_contribution: ${contribution.id}`);
    }
    this.items.set(contribution.id, contribution);
  }

  get(id: string): Contribution | undefined {
    return this.items.get(id);
  }

  /** Contributions for an area, in registration order. */
  list(area: ContribArea): Contribution[] {
    return [...this.items.values()].filter((item) => item.area === area);
  }

  clear(): void {
    this.items.clear();
  }
}

/** Process-wide registry used by the ossuary shell. */
export const contrib_registry = new ContribRegistry();

export function register(contribution: Contribution): void {
  contrib_registry.register(contribution);
}

export function list_by_area(area: ContribArea): Contribution[] {
  return contrib_registry.list(area);
}
