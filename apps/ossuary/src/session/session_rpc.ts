/** Typed session.* RPCs for Chat and Sessions panes (no renderer FS). */
import { request_gateway } from "../gateway-client";
import { as_record } from "../chat/wire_guards";

export interface SessionListEntry {
  id: string;
  mtime_ms: number;
}

function require_session_id(result: unknown, method: string): string {
  const record = as_record(result);
  if (record === undefined || typeof record.session_id !== "string") {
    throw new Error(`unexpected ${method} result`);
  }
  return record.session_id;
}

export async function session_create(source: string, label?: string): Promise<string> {
  const params: Record<string, unknown> = { source };
  if (label !== undefined) {
    params.label = label;
  }
  return require_session_id(await request_gateway("session.create", params), "session.create");
}

export async function session_list(): Promise<SessionListEntry[]> {
  const result = await request_gateway("session.list", {});
  const sessions = as_record(result)?.sessions;
  if (!Array.isArray(sessions)) {
    throw new Error("unexpected session.list result");
  }
  return sessions.map((value) => {
    const record = as_record(value);
    if (record === undefined || typeof record.id !== "string" || typeof record.mtime_ms !== "number") {
      throw new Error("unexpected session.list entry");
    }
    return { id: record.id, mtime_ms: record.mtime_ms };
  });
}

export async function session_resume(
  id: string,
): Promise<{ session_id: string; message_count: number }> {
  const record = as_record(await request_gateway("session.resume", { id }));
  if (
    record === undefined ||
    typeof record.session_id !== "string" ||
    typeof record.message_count !== "number"
  ) {
    throw new Error("unexpected session.resume result");
  }
  return { session_id: record.session_id, message_count: record.message_count };
}

export async function session_clear(session_id: string): Promise<string> {
  return require_session_id(
    await request_gateway("session.clear", { session_id }),
    "session.clear",
  );
}
