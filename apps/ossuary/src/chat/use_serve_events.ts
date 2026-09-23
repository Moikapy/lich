/** Apply serve `event` notifications into UiState + transcript blocks. */
import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { subscribe_notifications } from "../gateway-client";
import { apply_event } from "./apply_event";
import { parse_serve_event_params } from "./parse_event";
import { event_blocks } from "./event_blocks";
import { HISTORY_CAP, type HistoryBlock, type UiState } from "./types";

export function use_serve_events(
  session_ref: MutableRefObject<string | undefined>,
  set_ui: Dispatch<SetStateAction<UiState>>,
  set_blocks: Dispatch<SetStateAction<readonly HistoryBlock[]>>,
): void {
  useEffect(() => {
    return subscribe_notifications((method, params) => {
      if (method !== "event") {
        return;
      }
      const parsed = parse_serve_event_params(params);
      if (parsed === undefined || parsed.session_id !== session_ref.current) {
        return;
      }
      set_ui((current) => apply_event(current, parsed.event));
      set_blocks((current) => [...current, ...event_blocks(parsed.event)].slice(-HISTORY_CAP));
    });
  }, [session_ref, set_blocks, set_ui]);
}
