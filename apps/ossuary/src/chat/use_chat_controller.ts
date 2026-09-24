/** Compose Chat pane hooks: connection, session, events, submit/abort. */
import { useState } from "react";
import { use_gateway_connection } from "./use_gateway_connection";
import { use_prompt_actions } from "./use_prompt_actions";
import { use_serve_events } from "./use_serve_events";
import { use_serve_session } from "./use_serve_session";
import { INITIAL_UI_STATE, type HistoryBlock, type UiState } from "./types";
import type { ConnectionInfo } from "../gateway-client";

export interface ChatController {
  connection: ConnectionInfo;
  session_id: string | undefined;
  session_error: string | undefined;
  ui: UiState;
  blocks: readonly HistoryBlock[];
  draft: string;
  busy: boolean;
  set_draft: (value: string) => void;
  send: () => void;
  abort: () => void;
}

export function use_chat_controller(): ChatController {
  const connection = use_gateway_connection();
  const [ui, set_ui] = useState<UiState>(INITIAL_UI_STATE);
  const [blocks, set_blocks] = useState<readonly HistoryBlock[]>([]);
  const [draft, set_draft] = useState("");
  const [busy, set_busy] = useState(false);
  const { session_id, session_error, session_ref } = use_serve_session(connection, set_busy);

  use_serve_events(session_ref, set_ui, set_blocks);
  const { send, abort } = use_prompt_actions(
    session_ref,
    draft,
    busy,
    set_draft,
    set_busy,
    set_ui,
    set_blocks,
  );

  return {
    connection,
    session_id,
    session_error,
    ui,
    blocks,
    draft,
    busy,
    set_draft,
    send,
    abort,
  };
}
