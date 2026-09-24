/**
 * Shared serve connection + session + UiState + tool_log for docked panes.
 * Chat creates prompts; status / tool_log read the same event stream.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction,
} from "react";
import { apply_event } from "../chat/apply_event";
import { parse_serve_event_params } from "../chat/parse_event";
import { apply_tool_log_event, type ToolLogEntry } from "../chat/tool_log";
import { INITIAL_UI_STATE, type UiState } from "../chat/types";
import { use_gateway_connection } from "../chat/use_gateway_connection";
import { use_serve_session } from "../chat/use_serve_session";
import { subscribe_notifications, type ConnectionInfo } from "../gateway-client";

export interface ServeRuntime {
  connection: ConnectionInfo;
  session_id: string | undefined;
  session_error: string | undefined;
  session_ref: MutableRefObject<string | undefined>;
  ui: UiState;
  set_ui: Dispatch<SetStateAction<UiState>>;
  tool_log: readonly ToolLogEntry[];
  /** Serve does not expose model yet; mirrors TUI fallback. */
  model: string;
}

const ServeRuntimeContext = createContext<ServeRuntime | null>(null);

export function ServeRuntimeProvider({ children }: { children: ReactNode }) {
  const connection = use_gateway_connection();
  const { session_id, session_error, session_ref } = use_serve_session(connection);
  const [ui, set_ui] = useState<UiState>(INITIAL_UI_STATE);
  const [tool_log, set_tool_log] = useState<readonly ToolLogEntry[]>([]);

  useEffect(() => {
    set_ui(INITIAL_UI_STATE);
    set_tool_log([]);
  }, [session_id]);

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
      set_tool_log((current) => apply_tool_log_event(current, parsed.event));
    });
  }, [session_ref]);

  const value = useMemo(
    () => ({
      connection,
      session_id,
      session_error,
      session_ref,
      ui,
      set_ui,
      tool_log,
      model: "unknown",
    }),
    [connection, session_error, session_id, session_ref, tool_log, ui],
  );

  return <ServeRuntimeContext.Provider value={value}>{children}</ServeRuntimeContext.Provider>;
}

export function use_serve_runtime(): ServeRuntime {
  const value = useContext(ServeRuntimeContext);
  if (value === null) {
    throw new Error("use_serve_runtime requires ServeRuntimeProvider");
  }
  return value;
}
