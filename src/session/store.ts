/**
 * JSONL transcript persistence for agent sessions. Each session is one
 * append-only .jsonl file; records carry either a message or arbitrary meta.
 */
import { randomBytes } from "node:crypto";
import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { tool_message_from_result } from "../agent/loop.js";
import type { Message, ToolCall } from "../providers/types.js";
import { safe_json_parse, safe_stringify } from "../util/json.js";

export interface SessionRecord {
  ts: string;
  kind: "message" | "meta";
  message?: Message;
  meta?: Record<string, unknown>;
}

export interface SessionHandle {
  id: string;
  path: string;
  append(record: SessionRecord): Promise<void>;
}

/** Mutable via holder object: conventions require const bindings. */
const counter_state = { value: 0 };

const MESSAGE_ROLES: ReadonlySet<string> = new Set(["system", "user", "assistant", "tool"]);
const CREATE_ATTEMPTS = 8;

function slugify_label(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug.length > 0 ? `-${slug}` : "";
}

function next_session_id(label_part: string): string {
  counter_state.value += 1;
  const rand = randomBytes(3).toString("hex");
  return `${Date.now().toString(36)}-${process.pid.toString(36)}-${rand}-${counter_state.value}${label_part}`;
}

async function create_unique_session_path(dir: string, label_part: string): Promise<{ id: string; path: string }> {
  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
    const id = next_session_id(label_part);
    const file_path = path.join(dir, `${id}.jsonl`);
    try {
      await access(file_path);
      // Already taken; try another id.
      continue;
    } catch {
      // Path is free — create lazily on first append so empty TUI launches leave no file.
      return { id, path: file_path };
    }
  }
  throw new Error(`could not create unique session file in ${dir}`);
}

export async function open_session(dir: string, label?: string): Promise<SessionHandle> {
  await mkdir(dir, { recursive: true });
  const label_part = label === undefined ? "" : slugify_label(label);
  const created = await create_unique_session_path(dir, label_part);
  return {
    id: created.id,
    path: created.path,
    append: async (record: SessionRecord): Promise<void> => {
      await appendFile(created.path, `${safe_stringify(record)}\n`, "utf8");
    },
  };
}

function is_message(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const role = (value as { role?: unknown }).role;
  return typeof role === "string" && MESSAGE_ROLES.has(role);
}

/** Crash between llm_end and tool_call_end: tool_use with no result breaks the next provider call. */
function close_dangling_tool_calls(messages: readonly Message[]): Message[] {
  const closed: Message[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (message === undefined) {
      break;
    }
    closed.push(message);
    index += 1;
    const calls = message.role === "assistant" ? message.tool_calls : undefined;
    if (calls === undefined || calls.length === 0) {
      continue;
    }
    const seen = collect_following_tool_ids(messages, index, closed);
    index += seen.consumed;
    append_missing_tool_results(calls, seen.ids, closed);
  }
  return closed;
}

function collect_following_tool_ids(
  messages: readonly Message[],
  start: number,
  closed: Message[],
): { ids: Set<string>; consumed: number } {
  const ids = new Set<string>();
  let consumed = 0;
  while (start + consumed < messages.length && messages[start + consumed]?.role === "tool") {
    const tool_message = messages[start + consumed];
    if (tool_message?.role === "tool") {
      ids.add(tool_message.tool_call_id);
      closed.push(tool_message);
    }
    consumed += 1;
  }
  return { ids, consumed };
}

function append_missing_tool_results(calls: readonly ToolCall[], seen: Set<string>, closed: Message[]): void {
  for (const call of calls) {
    if (seen.has(call.id) === true) {
      continue;
    }
    closed.push(tool_message_from_result(call, { ok: false, output: "", error: "cancelled" }));
  }
}

/**
 * Drop a user line that never got an assistant or tool result when a later
 * turn appended after it (meta sits between the two user lines). Adjacent
 * user lines stay: a compression summary is stored that way. The caller drops
 * a trailing run of user lines.
 */
function drop_interrupted_user_seeds(records: readonly SessionRecord[]): Message[] {
  const kept: Message[] = [];
  let pending: Message | undefined;
  let meta_since_pending = false;
  const take_pending = (keep: boolean): void => {
    if (pending !== undefined && keep === true) {
      kept.push(pending);
    }
    pending = undefined;
    meta_since_pending = false;
  };
  for (const record of records) {
    const message = record.kind === "message" ? record.message : undefined;
    if (message === undefined || is_message(message) === false) {
      if (record.kind === "meta" && pending !== undefined) {
        meta_since_pending = true;
      }
      continue;
    }
    if (message.role === "user") {
      if (pending !== undefined) {
        take_pending(meta_since_pending === false);
      }
      pending = message;
      meta_since_pending = false;
      continue;
    }
    take_pending(true);
    kept.push(message);
  }
  take_pending(false);
  return kept;
}

export async function read_session_messages(file_path: string): Promise<Message[]> {
  // Missing files rethrow (ENOENT) so callers can tell "vanished" from "empty".
  const raw = await readFile(file_path, "utf8");
  const records: SessionRecord[] = [];
  for (const line of raw.split("\n")) {
    const record = safe_json_parse<SessionRecord>(line);
    if (record !== undefined) {
      records.push(record);
    }
  }
  const closed = close_dangling_tool_calls(drop_interrupted_user_seeds(records));
  // Provider throw / abort-before-turn can leave a dangling user seed with no
  // assistant reply, and repeated failures stack several. Drop them all so
  // resume never starts with consecutive users and the result is idempotent
  // (a serve fork written from it reads back unchanged).
  while (closed.at(-1)?.role === "user") {
    closed.pop();
  }
  return closed;
}
