/** Apply Sessions pane bind switches to Chat transcript / UI. */
import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { SessionBinding } from "../session/active_session";
import { resume_banner_block } from "../session/resume_banner";
import { INITIAL_UI_STATE, type HistoryBlock, type UiState } from "./types";

export function use_session_bind_effects(
  binding: SessionBinding | undefined,
  set_ui: Dispatch<SetStateAction<UiState>>,
  set_blocks: Dispatch<SetStateAction<readonly HistoryBlock[]>>,
  set_busy: Dispatch<SetStateAction<boolean>>,
): void {
  useEffect(() => {
    if (binding === undefined || binding.source === "auto_create") {
      return;
    }
    set_ui(INITIAL_UI_STATE);
    set_busy(false);
    if (binding.source === "resume" && binding.resume_id !== undefined) {
      set_blocks([resume_banner_block(binding.resume_id, binding.message_count ?? 0)]);
      return;
    }
    set_blocks([]);
  }, [binding?.seq, set_blocks, set_busy, set_ui]);
}
