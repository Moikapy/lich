/** prompt.submit / prompt.abort actions for the Chat pane. */
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { apply_submit_result } from "./apply_submit_result";
import { prompt_abort, prompt_submit } from "./rpc";
import { submit_notice_blocks } from "./submit_notices";
import { error_notice_block, user_block } from "./transcript";
import { HISTORY_CAP, type HistoryBlock, type UiState } from "./types";

export function use_prompt_actions(
  session_ref: MutableRefObject<string | undefined>,
  draft: string,
  busy: boolean,
  set_draft: (value: string) => void,
  set_busy: Dispatch<SetStateAction<boolean>>,
  set_ui: Dispatch<SetStateAction<UiState>>,
  set_blocks: Dispatch<SetStateAction<readonly HistoryBlock[]>>,
): { send: () => void; abort: () => void } {
  const send = useCallback(() => {
    const text = draft.trim();
    const id = session_ref.current;
    if (text.length === 0 || id === undefined || busy) {
      return;
    }
    set_draft("");
    set_busy(true);
    set_blocks((current) => [...current, user_block(text)].slice(-HISTORY_CAP));
    set_ui((current) => ({ ...current, phase: "thinking", active_tool: undefined }));
    void prompt_submit(id, text)
      .then((result) => {
        set_ui((current) => apply_submit_result(current, result));
        set_blocks((current) => [...current, ...submit_notice_blocks(result)].slice(-HISTORY_CAP));
      })
      .catch((error: unknown) => {
        set_blocks((current) =>
          [...current, error_notice_block(error instanceof Error ? error.message : String(error))].slice(
            -HISTORY_CAP,
          ),
        );
        set_ui((current) => ({ ...current, phase: "idle" }));
      })
      .finally(() => {
        set_busy(false);
      });
  }, [busy, draft, session_ref, set_blocks, set_busy, set_draft, set_ui]);

  const abort = useCallback(() => {
    const id = session_ref.current;
    if (id !== undefined) {
      void prompt_abort(id).catch(() => undefined);
    }
  }, [session_ref]);

  return { send, abort };
}
