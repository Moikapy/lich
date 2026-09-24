/**
 * Full-window Chat pane: session.create on connect, prompt.submit / abort,
 * apply serve event notifications with TUI apply_event semantics.
 */
import { useEffect, useRef, type FormEvent } from "react";
import { format_chat_status } from "../chat/format_status";
import { use_chat_controller } from "../chat/use_chat_controller";

export function ChatPane() {
  const chat = use_chat_controller();
  const transcript_ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    transcript_ref.current?.scrollTo({ top: transcript_ref.current.scrollHeight });
  }, [chat.blocks]);

  const on_submit = (event: FormEvent) => {
    event.preventDefault();
    chat.send();
  };

  return (
    <section className="pane pane-chat" aria-label="Chat" data-testid="chat-pane">
      <header className="chat-header">
        <h1>chat</h1>
        <p className="chat-status" data-testid="chat-status">
          {format_chat_status(chat.connection, chat.session_id, chat.session_error, chat.ui)}
        </p>
      </header>
      <div className="chat-transcript" ref={transcript_ref} data-testid="chat-transcript">
        {chat.blocks.length === 0 ? (
          <p className="chat-empty">Send a message to start a multi-turn session.</p>
        ) : (
          chat.blocks.map((block, index) => (
            <div key={`${block.role}-${index}`} className={`chat-block chat-block-${block.role}`}>
              {block.lines.map((line, line_index) => (
                <div key={line_index}>{line}</div>
              ))}
            </div>
          ))
        )}
      </div>
      <form className="chat-composer" onSubmit={on_submit}>
        <input
          className="chat-input"
          data-testid="chat-input"
          value={chat.draft}
          onChange={(event) => chat.set_draft(event.target.value)}
          placeholder={chat.session_id === undefined ? "waiting for session…" : "message"}
          disabled={chat.session_id === undefined || chat.connection.status !== "connected"}
          autoComplete="off"
        />
        <button
          type="submit"
          data-testid="chat-send"
          disabled={chat.busy || chat.session_id === undefined}
        >
          send
        </button>
        <button
          type="button"
          data-testid="chat-abort"
          onClick={chat.abort}
          disabled={chat.busy === false || chat.session_id === undefined}
        >
          abort
        </button>
      </form>
    </section>
  );
}
