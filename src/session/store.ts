/**
 * JSONL transcript persistence for agent sessions. Each session is one
 * append-only .jsonl file; records carry either a message or arbitrary meta.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Message } from "../providers/types.js";
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

function slugify_label(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug.length > 0 ? `-${slug}` : "";
}

export async function open_session(dir: string, label?: string): Promise<SessionHandle> {
  await mkdir(dir, { recursive: true });
  counter_state.value += 1;
  const label_part = label === undefined ? "" : slugify_label(label);
  const id = `${Date.now().toString(36)}-${counter_state.value}${label_part}`;
  const file_path = path.join(dir, `${id}.jsonl`);
  return {
    id,
    path: file_path,
    append: async (record: SessionRecord): Promise<void> => {
      await appendFile(file_path, `${safe_stringify(record)}\n`, "utf8");
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
  // Provider throw / abort-before-turn can leave a dangling user seed with no
  // assistant reply. Drop it so resume does not start with two consecutive users.
  const last = messages.at(-1);
  if (last?.role === "user") {
    messages.pop();
  }
  return messages;
}