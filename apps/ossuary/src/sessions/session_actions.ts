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

/** Create a fresh serve session first, then clear the previous bag if any. */
export async function start_fresh_session(): Promise<void> {
  const previous = get_active_session()?.session_id;
  const session_id = await session_create("ossuary", "fresh");
  bind_active_session({ session_id, source: "create" });
  if (previous !== undefined && previous !== session_id) {
    await session_clear(previous).catch(() => undefined);
  }
}

export async function clear_active_session(): Promise<void> {
  const current = get_active_session()?.session_id;
  if (current === undefined) {
    return;
  }
  const session_id = await session_clear(current);
  bind_active_session({ session_id, source: "clear" });
}
