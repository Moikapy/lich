/** Status pane: model / phase / turns / tokens / session path (TUI status analogue). */
import { format_status_pane_fields } from "../chat/format_status_pane";
import { use_serve_runtime } from "../session/serve_runtime";

export function StatusPane() {
  const { connection, ui, model } = use_serve_runtime();
  const fields = format_status_pane_fields(connection, ui, model);

  return (
    <section className="pane pane-status" aria-label="Status" data-testid="status-pane">
      <header className="pane-header">
        <h1>status</h1>
      </header>
      <dl className="status-fields" data-testid="status-fields">
        <div>
          <dt>connection</dt>
          <dd>{fields.connection}</dd>
        </div>
        <div>
          <dt>model</dt>
          <dd>{fields.model}</dd>
        </div>
        <div>
          <dt>phase</dt>
          <dd>{fields.phase}</dd>
        </div>
        <div>
          <dt>turns</dt>
          <dd>{fields.turns}</dd>
        </div>
        <div>
          <dt>tokens</dt>
          <dd>{fields.tokens}</dd>
        </div>
        <div>
          <dt>session</dt>
          <dd className="status-path">{fields.session_path}</dd>
        </div>
      </dl>
    </section>
  );
}
