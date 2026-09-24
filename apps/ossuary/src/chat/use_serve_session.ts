/** Create a serve session on connect; follow Sessions pane bind switches. */
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { ConnectionInfo } from "../gateway-client";
import {
  bind_active_session,
  get_active_session,
  subscribe_active_session,
  type SessionBinding,
} from "../session/active_session";
import { session_create } from "../session/session_rpc";

export function use_serve_session(
  connection: ConnectionInfo,
  set_busy?: Dispatch<SetStateAction<boolean>>,
): {
  session_id: string | undefined;
  session_error: string | undefined;
  session_ref: MutableRefObject<string | undefined>;
  binding: SessionBinding | undefined;
} {
  const [session_id, set_session_id] = useState<string | undefined>();
  const [session_error, set_session_error] = useState<string | undefined>();
  const [binding, set_binding] = useState<SessionBinding | undefined>();
  const session_ref = useRef<string | undefined>(undefined);

  useEffect(() => subscribe_active_session((next) => {
    session_ref.current = next.session_id;
    set_session_id(next.session_id);
    set_binding(next);
    set_session_error(undefined);
  }), []);

  useEffect(() => {
    if (connection.status !== "connected") {
      session_ref.current = undefined;
      set_session_id(undefined);
      set_busy?.(false);
      return;
    }
    const existing = get_active_session();
    if (existing !== undefined) {
      session_ref.current = existing.session_id;
      set_session_id(existing.session_id);
      set_binding(existing);
      return;
    }
    let cancelled = false;
    void session_create("ossuary")
      .then((id) => {
        if (cancelled || get_active_session() !== undefined) {
          return;
        }
        bind_active_session({ session_id: id, source: "auto_create" });
      })
      .catch((error: unknown) => {
        if (!cancelled && get_active_session() === undefined) {
          set_session_error(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connection.status, set_busy]);

  return { session_id, session_error, session_ref, binding };
}
