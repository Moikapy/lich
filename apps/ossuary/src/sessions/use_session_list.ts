/** Load session.list while connected; track active bind highlight. */
import { useCallback, useEffect, useState } from "react";
import { use_gateway_connection } from "../chat/use_gateway_connection";
import { subscribe_active_session } from "../session/active_session";
import { session_list, type SessionListEntry } from "../session/session_rpc";
import type { SessionListState } from "./sessions_pane_types";

export function error_text(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function use_session_list(): SessionListState {
  const connection = use_gateway_connection();
  const [sessions, set_sessions] = useState<SessionListEntry[]>([]);
  const [active_id, set_active_id] = useState<string | undefined>();
  const [highlight_id, set_highlight_id] = useState<string | undefined>();
  const [busy, set_busy] = useState(false);
  const [error, set_error] = useState<string | undefined>();

  useEffect(
    () =>
      subscribe_active_session((binding) => {
        set_active_id(binding.session_id);
        set_highlight_id(binding.resume_id);
      }),
    [],
  );

  const refresh = useCallback((): boolean => {
    if (connection.status !== "connected") {
      set_busy(false);
      return false;
    }
    set_busy(true);
    void session_list()
      .then((entries) => {
        set_sessions(entries);
        set_error(undefined);
      })
      .catch((err: unknown) => set_error(error_text(err)))
      .finally(() => set_busy(false));
    return true;
  }, [connection.status]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    connection,
    sessions,
    active_id,
    highlight_id,
    busy,
    error,
    set_busy,
    set_error,
    refresh,
  };
}
