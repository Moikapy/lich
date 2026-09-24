/** Sessions pane: list / resume / create / clear via session.* RPCs. */
import { useCallback } from "react";
import {
  clear_active_session,
  resume_listed_session,
  start_fresh_session,
} from "./session_actions";
import type { SessionsPaneModel } from "./sessions_pane_types";
import { error_text, use_session_list } from "./use_session_list";

export function use_sessions_pane(): SessionsPaneModel {
  const list = use_session_list();
  const { set_busy, set_error, refresh } = list;

  const run = useCallback(
    (work: () => Promise<void>, then_refresh = false) => {
      set_busy(true);
      void work()
        .then(() => {
          set_error(undefined);
          if (then_refresh) {
            if (refresh() === false) {
              set_busy(false);
            }
          } else {
            set_busy(false);
          }
        })
        .catch((err: unknown) => {
          set_error(error_text(err));
          set_busy(false);
        });
    },
    [refresh, set_busy, set_error],
  );

  return {
    connection: list.connection,
    sessions: list.sessions,
    active_id: list.active_id,
    highlight_id: list.highlight_id,
    busy: list.busy,
    error: list.error,
    refresh,
    resume: (id) => run(() => resume_listed_session(id), true),
    start_fresh: () => run(() => start_fresh_session(), true),
    clear_active: () => run(() => clear_active_session()),
  };
}
