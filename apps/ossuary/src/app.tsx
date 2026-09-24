import { ChatPane } from "./panes/chat";

/** Full-window Chat until Dockview (#89) hosts registered `lich.chat`. */
export function App() {
  return (
    <main className="shell" data-pane-id="lich.chat">
      <ChatPane />
    </main>
  );
}
