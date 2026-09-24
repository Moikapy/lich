import type { ConnectionInfo } from "../gateway-client";
import type { SessionListEntry } from "../session/session_rpc";

export interface SessionListState {
  connection: ConnectionInfo;
  sessions: SessionListEntry[];
  active_id: string | undefined;
  highlight_id: string | undefined;
  busy: boolean;
  error: string | undefined;
  set_busy: (value: boolean) => void;
  set_error: (value: string | undefined) => void;
  refresh: () => boolean;
}

export interface SessionsPaneModel {
  connection: ConnectionInfo;
  sessions: SessionListEntry[];
  active_id: string | undefined;
  highlight_id: string | undefined;
  busy: boolean;
  error: string | undefined;
  refresh: () => boolean;
  resume: (id: string) => void;
  start_fresh: () => void;
  clear_active: () => void;
}
