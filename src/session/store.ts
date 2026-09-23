/**
 * JSONL transcript persistence for agent sessions. Each session is one
 * append-only .jsonl file; records carry either a message or arbitrary meta.
 */
import { randomBytes } from "node:crypto";
import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Message } from "../providers/types.js";
import { safe_json_parse, safe_stringify } from "../util/json.js";
import { is_enoent } from "../util/fs.js";

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

export async function read_session_messages(file_path: string): Promise<Message[]> {
  let raw: string;
  try {
    raw = await readFile(file_path, "utf8");
  } catch (error) {
    if (is_enoent(error) === true) {
      return [];
    }
    throw error;
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
