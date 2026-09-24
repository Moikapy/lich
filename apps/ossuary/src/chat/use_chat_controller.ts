/** Compose Chat pane hooks: shared serve runtime + local transcript / composer. */
import { useEffect, useState } from "react";
import { use_serve_runtime } from "../session/serve_runtime";
import { use_prompt_actions } from "./use_prompt_actions";
import { use_serve_events } from "./use_serve_events";
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
