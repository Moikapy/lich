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

export async function read_session_messages(file_path: string): Promise<Message[]> {
  let raw: string;
  try {
    raw = await readFile(file_path, "utf8");
  } catch {
    return [];
  }
  const messages: Message[] = [];
  for (const line of raw.split("\n")) {
    const record = safe_json_parse<SessionRecord>(line);
    if (record?.message !== undefined && is_message(record.message)) {
      messages.push(record.message);
    }
  }
  const closed = close_dangling_tool_calls(messages);
  // Provider throw / abort-before-turn can leave a dangling user seed with no
  // assistant reply. Drop it so resume does not start with two consecutive users.
  const last = closed.at(-1);
  if (last?.role === "user") {
    closed.pop();
  }
  return closed;
}
