import { register_core_contributions } from "./contrib/register_core";
import { list_by_area, type PaneContribution } from "./contrib/registry";

register_core_contributions();

function pick_main_pane(panes: PaneContribution[]): PaneContribution | undefined {
  return panes.find((pane) => pane.data.placement === "main") ?? panes[0];
}

/** Naive shell: mount the main registered pane until Dockview (#89). */
export function App() {
  const panes = list_by_area("panes") as PaneContribution[];
  const main = pick_main_pane(panes);
  if (!main) {
    return (
      <main className="hello">
        <h1>ossuary</h1>
        <p>No panes registered.</p>
      </main>
    );
  }

  const Pane = main.render;
  return (
    <main className="shell" data-pane-id={main.id}>
      <Pane />
    </main>
  );
}
