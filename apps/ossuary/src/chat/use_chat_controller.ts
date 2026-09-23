/** Compose Chat pane hooks: shared serve runtime + local transcript / composer. */
import { useEffect, useState } from "react";
import { use_serve_runtime } from "../session/serve_runtime";
import { cleared_chat_local_state } from "./chat_local_state";
import { use_prompt_actions } from "./use_prompt_actions";
import { use_serve_events } from "./use_serve_events";
import { use_session_bind_effects } from "./use_session_bind_effects";
import type { ConnectionInfo } from "../gateway-client";
import type { HistoryBlock, UiState } from "./types";

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
  const runtime = use_serve_runtime();
  const [blocks, set_blocks] = useState<readonly HistoryBlock[]>([]);
  const [draft, set_draft] = useState("");
  const [busy, set_busy] = useState(false);

  useEffect(() => {
    if (runtime.connection.status !== "connected") {
      set_busy(false);
    }
  }, [runtime.connection.status]);

  // auto_create / unbound: clear local transcript when session_id changes.
  // resume / create / clear: use_session_bind_effects owns blocks + banner.
  useEffect(() => {
    if (runtime.binding !== undefined && runtime.binding.source !== "auto_create") {
      return;
    }
    const cleared = cleared_chat_local_state();
    set_blocks(cleared.blocks);
    set_busy(cleared.busy);
  }, [runtime.session_id, runtime.binding?.source]);

  use_session_bind_effects(runtime.binding, runtime.set_ui, set_blocks, set_busy);
  use_serve_events(runtime.session_ref, set_blocks);
  const { send, abort } = use_prompt_actions(
    runtime.session_ref,
    draft,
    busy,
    set_draft,
    set_busy,
    runtime.set_ui,
    set_blocks,
  );

  return {
    connection: runtime.connection,
    session_id: runtime.session_id,
    session_error: runtime.session_error,
    ui: runtime.ui,
    blocks,
    draft,
    busy,
    set_draft,
    send,
    abort,
  };
}
