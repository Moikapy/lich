/** Scratch/demo pane so Dockview split/tab works before #90–#91 land. */
export function PlaceholderPane() {
  return (
    <section
      className="pane pane-placeholder"
      aria-label="Placeholder"
      data-testid="placeholder-pane"
    >
      <header className="pane-header">
        <h1>scratch</h1>
      </header>
      <p className="pane-body">
        Placeholder pane for in-window split and tab. Tool log, status, and sessions
        panes land in later issues.
      </p>
    </section>
  );
}
