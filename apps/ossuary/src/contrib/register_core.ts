import { ChatPane } from "../panes/chat";
import { StatusPane } from "../panes/status";
import { ToolLogPane } from "../panes/tool_log";
import {
  contrib_registry,
  register_pane,
  type PaneContributionInput,
} from "./registry";

const CORE_PANES: PaneContributionInput[] = [
  {
    id: "lich.chat",
    title: "Chat",
    data: { placement: "main", closable: false },
    render: ChatPane,
  },
  {
    id: "lich.status",
    title: "Status",
    data: { placement: "right" },
    render: StatusPane,
  },
  {
    id: "lich.tool_log",
    title: "Tool log",
    data: { placement: "bottom" },
    render: ToolLogPane,
  },
];

/** Update `render` on an existing pane, or register it if missing (HMR-safe). */
function ensure_core_pane(input: PaneContributionInput): void {
  const existing = contrib_registry.get(input.id);
  if (existing) {
    existing.render = input.render;
    return;
  }
  register_pane(input);
}

/**
 * Register first-party panes the same way future plugins will. Idempotent:
 * repeat calls and HMR module re-eval refresh `render` and fill any missing
 * core panes without throwing duplicate_contribution.
 */
export function register_core_contributions(): void {
  for (const pane of CORE_PANES) {
    ensure_core_pane(pane);
  }
}
