/** Apply prompt.submit settlement only while the submitted session is still active. */
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { apply_submit_result } from "./apply_submit_result";
import { error_text } from "./error_text";
import { submit_notice_blocks } from "./submit_notices";
import { error_notice_block } from "./transcript";
import { HISTORY_CAP, type HistoryBlock, type PromptSubmitResult, type UiState } from "./types";

export function create_prompt_submit_settle(
  submitted_id: string,
  session_ref: MutableRefObject<string | undefined>,
  set_ui: Dispatch<SetStateAction<UiState>>,
  set_blocks: Dispatch<SetStateAction<readonly HistoryBlock[]>>,
  set_busy: Dispatch<SetStateAction<boolean>>,
): {
  on_fulfilled: (result: PromptSubmitResult) => void;
  on_rejected: (error: unknown) => void;
  on_settled: () => void;
} {
  const still_active = (): boolean => session_ref.current === submitted_id;
  return {
    on_fulfilled(result) {
      if (!still_active()) {
        return;
      }
      set_ui((current) => apply_submit_result(current, result));
      set_blocks((current) => [...current, ...submit_notice_blocks(result)].slice(-HISTORY_CAP));
    },
    on_rejected(error) {
      if (!still_active()) {
        return;
      }
      set_blocks((current) =>
        [...current, error_notice_block(error_text(error))].slice(-HISTORY_CAP),
      );
      set_ui((current) => ({ ...current, phase: "idle" }));
    },
    on_settled() {
      if (still_active()) {
        set_busy(false);
      }
    },
  };
}
