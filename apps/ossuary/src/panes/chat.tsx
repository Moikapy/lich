/** Placeholder Chat pane — full serve wiring lands in #87. */
export function ChatPane() {
  return (
    <section className="pane pane-chat" aria-label="Chat">
      <header className="pane-header">
        <h1>chat</h1>
      </header>
      <p className="pane-body">Chat pane registered via contribution registry.</p>
    </section>
  );
}
