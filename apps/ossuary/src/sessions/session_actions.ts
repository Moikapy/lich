/** Session pane RPC actions that publish to the active-session bridge. */
import { bind_active_session, get_active_session } from "../session/active_session";
import { session_clear, session_create, session_resume } from "../session/session_rpc";

export async function resume_listed_session(id: string): Promise<void> {
  const result = await session_resume(id);
  bind_active_session({
    session_id: result.session_id,
    source: "resume",
    resume_id: id,
    message_count: result.message_count,
  });
}

/** Clear current bag (if any), then create a fresh serve session. */
export async function start_fresh_session(): Promise<void> {
  const current = get_active_session()?.session_id;
  if (current !== undefined) {
    await session_clear(current);
  }
  const session_id = await session_create("ossuary", "fresh");
  bind_active_session({ session_id, source: "create" });
}

export async function clear_active_session(): Promise<void> {
  const current = get_active_session()?.session_id;
  if (current === undefined) {
    return;
  }
  const session_id = await session_clear(current);
  bind_active_session({ session_id, source: "clear" });
}
