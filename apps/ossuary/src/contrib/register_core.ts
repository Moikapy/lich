import { ChatPane } from "../panes/chat";
import { StatusPane } from "../panes/status";
import { ToolLogPane } from "../panes/tool_log";
import { contrib_registry, register_pane } from "./registry";

/**
 * Register first-party panes the same way future plugins will. Idempotent:
 * repeat calls and HMR module re-eval hit the registry guard instead of
 * throwing duplicate_contribution.
 */
export function register_core_contributions(): void {
  if (contrib_registry.get("lich.chat")) {
    return;
  }
  register_pane({
    id: "lich.chat",
    title: "Chat",
    data: { placement: "main", closable: false },
    render: ChatPane,
  });
  register_pane({
    id: "lich.status",
    title: "Status",
    data: { placement: "right" },
    render: StatusPane,
  });
  register_pane({
    id: "lich.tool_log",
    title: "Tool log",
    data: { placement: "bottom" },
    render: ToolLogPane,
  });
}