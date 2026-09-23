/** Live tool_call_start / tool_call_end log docked beside Chat. */
import { truncate_text } from "../chat/transcript";
import type { ToolLogEntry } from "../chat/tool_log";
import { use_serve_runtime } from "../session/serve_runtime";

const ARGS_PREVIEW = 80;
const OUTPUT_PREVIEW = 160;

function status_label(entry: ToolLogEntry): string {
  if (entry.status === "running") {
    return "running";
  }
  if (entry.status === "cancelled") {
    return "cancelled";
  }
  return entry.status === "ok" ? "ok" : "error";
}

function format_row(entry: ToolLogEntry): string {
  const args = truncate_text(JSON.stringify(entry.args) ?? "{}", ARGS_PREVIEW);
  const head = `turn ${entry.turn} · ${entry.name}(${args}) · ${status_label(entry)}`;
  if (entry.status === "running") {
    return head;
  }
  const detail =
    entry.status === "error" && entry.error !== undefined
      ? entry.error
      : (entry.output ?? "");
  if (detail.length === 0) {
    return head;
  }
  return `${head}\n  ${truncate_text(detail, OUTPUT_PREVIEW)}`;
}

export function ToolLogPane() {
  const { tool_log } = use_serve_runtime();

  return (
    <section className="pane pane-tool-log" aria-label="Tool log" data-testid="tool-log-pane">
      <header className="pane-header">
        <h1>tool log</h1>
      </header>
      <div className="tool-log-list" data-testid="tool-log-list">
        {tool_log.length === 0 ? (
          <p className="pane-empty">Tool calls appear here during a run.</p>
        ) : (
          tool_log.map((entry) => (
            <pre
              key={entry.id}
              className={`tool-log-row tool-log-${entry.status}`}
              data-testid="tool-log-row"
            >
              {format_row(entry)}
            </pre>
          ))
        )}
      </div>
    </section>
  );
}
