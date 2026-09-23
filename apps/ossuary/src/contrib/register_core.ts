import { ChatPane } from "../panes/chat";
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
    data: { placement: "main" },
    render: ChatPane,
  });
}
