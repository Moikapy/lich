import { register_core_contributions } from "./contrib/register_core";
import { list_panes } from "./contrib/registry";
import { ServeRuntimeProvider } from "./session/serve_runtime";
import { DockShell } from "./shell/dock_shell";

register_core_contributions();

/** Dockview shell over contribution-registered panes (`lich.chat` is main). */
export function App() {
  const panes = list_panes();
  if (panes.length === 0) {
    return (
      <main className="hello">
        <h1>ossuary</h1>
        <p>No panes registered.</p>
      </main>
    );
  }

  return (
    <ServeRuntimeProvider>
      <main className="shell" data-testid="dock-shell">
        <DockShell panes={panes} />
      </main>
    </ServeRuntimeProvider>
  );
}
