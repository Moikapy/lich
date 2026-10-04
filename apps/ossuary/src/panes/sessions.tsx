/**
 * Sessions pane: list transcripts via session.list; resume / fresh / clear
 * over RPC (no renderer FS). Mirrors TUI resume banner via active-session bridge.
 */
import { use_sessions_pane } from "../sessions/use_sessions_pane";

function format_mtime(mtime_ms: number): string {
  return new Date(mtime_ms).toLocaleString();
}

export function SessionsPane() {
  const pane = use_sessions_pane();
  const connected = pane.connection.status === "connected";

  return (
    <section className="pane pane-sessions" aria-label="Sessions" data-testid="sessions-pane">
      <header className="pane-header sessions-header">
        <h1>sessions</h1>
        <p className="sessions-status" data-testid="sessions-status">
          {!connected
            ? pane.connection.status
            : pane.error !== undefined
              ? `error: ${pane.error}`
              : pane.active_id !== undefined
                ? `active ${pane.active_id.slice(0, 8)}`
                : "connected"}
        </p>
      </header>
      <div className="sessions-actions">
        <button
          type="button"
          data-testid="sessions-refresh"
          onClick={pane.refresh}
          disabled={!connected || pane.busy}
        >
          refresh
        </button>
        <button
          type="button"
          data-testid="sessions-fresh"
          onClick={pane.start_fresh}
          disabled={!connected || pane.busy}
        >
          new
        </button>
        <button
          type="button"
          data-testid="sessions-clear"
          onClick={pane.clear_active}
          disabled={!connected || pane.busy || pane.active_id === undefined}
        >
          clear
        </button>
      </div>
      <ul className="sessions-list" data-testid="sessions-list">
        {pane.sessions.length === 0 ? (
          <li className="sessions-empty">No session files yet.</li>
        ) : (
          pane.sessions.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className={
                  entry.id === pane.highlight_id
                    ? "sessions-item sessions-item-active"
                    : "sessions-item"
                }
                data-testid={`sessions-item-${entry.id}`}
                onClick={() => pane.resume(entry.id)}
                disabled={!connected || pane.busy}
              >
                <span className="sessions-item-id">{entry.id}</span>
                <span className="sessions-item-mtime">{format_mtime(entry.mtime_ms)}</span>
              </button>
            </li>
          ))
        )}
      </ul>
    </section>
  );
}
