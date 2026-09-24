/** Create a serve session once the gateway reports connected. */
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { ConnectionInfo } from "../gateway-client";
import { session_create } from "./rpc";

export function use_serve_session(
  connection: ConnectionInfo,
  set_busy: Dispatch<SetStateAction<boolean>>,
): {
  session_id: string | undefined;
  session_error: string | undefined;
  session_ref: MutableRefObject<string | undefined>;
} {
  const [session_id, set_session_id] = useState<string | undefined>();
  const [session_error, set_session_error] = useState<string | undefined>();
  const session_ref = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (connection.status !== "connected") {
      session_ref.current = undefined;
      set_session_id(undefined);
      set_busy(false);
      return;
    }
    let cancelled = false;
    void session_create("ossuary")
      .then((id) => {
        if (!cancelled) {
          session_ref.current = id;
          set_session_id(id);
          set_session_error(undefined);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          set_session_error(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connection.status, set_busy]);

  return { session_id, session_error, session_ref };
}
