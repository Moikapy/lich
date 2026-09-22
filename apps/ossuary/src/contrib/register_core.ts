import { ChatPane } from "../panes/chat";
import { register } from "./registry";

let core_registered = false;

/** Register first-party panes the same way future plugins will. */
export function register_core_contributions(): void {
  if (core_registered) {
    return;
  }
  core_registered = true;
  register({
    id: "lich.chat",
    area: "panes",
    title: "Chat",
    data: { placement: "main" },
    render: ChatPane,
  });
}
