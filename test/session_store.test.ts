import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { open_session, read_session_messages } from "../src/session/store.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

describe("open_session", () => {
  it("embeds pid and random entropy in the session id without creating empty files", async () => {
    await mkdir(TMP_BASE, { recursive: true });
    const dir = await mkdtemp(path.join(TMP_BASE, "session-id-"));
    try {
      const a = await open_session(dir, "alpha");
      const b = await open_session(dir, "alpha");
      const pid_part = process.pid.toString(36);
      expect(a.id).toContain(`-${pid_part}-`);
      expect(b.id).toContain(`-${pid_part}-`);
      expect(a.id).not.toBe(b.id);
      expect(a.path).not.toBe(b.path);
      expect(a.id).toMatch(/-[0-9a-f]{6}-\d+-alpha$/);
      await expect(stat(a.path)).rejects.toMatchObject({ code: "ENOENT" });
      await a.append({ ts: new Date().toISOString(), kind: "meta", meta: { hello: true } });
      const info = await stat(a.path);
      expect(info.isFile()).toBe(true);
      expect(info.size).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps a hostile label inside the session directory and caps the slug", async () => {
    await mkdir(TMP_BASE, { recursive: true });
    const dir = await mkdtemp(path.join(TMP_BASE, "session-label-"));
    try {
      const hostile = await open_session(dir, "../secret/../../etc/passwd");
      expect(path.dirname(hostile.path)).toBe(dir);
      expect(hostile.id.includes("..")).toBe(false);
      expect(hostile.id.includes("/")).toBe(false);
      expect(hostile.id.endsWith("-secret-etc-passwd")).toBe(true);
      await hostile.append({ ts: "2026-01-01T00:00:00.000Z", kind: "meta", meta: { ok: true } });
      expect((await stat(hostile.path)).isFile()).toBe(true);

      const punctuation = await open_session(dir, "!!!");
      expect(punctuation.id).toMatch(/-\d+$/);
      expect(punctuation.path.startsWith(`${dir}${path.sep}`)).toBe(true);

      const capped = await open_session(dir, "a".repeat(80));
      expect(capped.id.endsWith(`-${"a".repeat(40)}`)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("read_session_messages", () => {
  it("rethrows ENOENT so callers can tell vanished from empty", async () => {
    await mkdir(TMP_BASE, { recursive: true });
    const dir = await mkdtemp(path.join(TMP_BASE, "session-read-missing-"));
    try {
      const missing = path.join(dir, "missing.jsonl");
      await expect(read_session_messages(missing)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("parses an empty transcript file to zero messages (serve eager-create shape)", async () => {
    await mkdir(TMP_BASE, { recursive: true });
    const dir = await mkdtemp(path.join(TMP_BASE, "session-read-empty-"));
    try {
      const empty = path.join(dir, "empty.jsonl");
      await writeFile(empty, "", "utf8");
      expect(await read_session_messages(empty)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops roles outside the transcript allowlist and keeps the surrounding turns", async () => {
    await mkdir(TMP_BASE, { recursive: true });
    const dir = await mkdtemp(path.join(TMP_BASE, "session-roles-"));
    try {
      const file_path = path.join(dir, "mixed.jsonl");
      const lines = [
        { kind: "message", message: { role: "user", content: "keep-user" } },
        { kind: "message", message: { role: "function", content: "injected" } },
        { kind: "message", message: { role: "User", content: "case" } },
        { kind: "message", message: "nope" },
        { kind: "message", message: { content: "missing-role" } },
        {
          kind: "message",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "c1", name: "read_file", args: { path: "a.txt" } }],
          },
        },
        { kind: "message", message: { role: "tool", tool_call_id: "c1", name: "read_file", content: "kept-tool" } },
        { kind: "message", message: { role: "assistant", content: "keep-assistant" } },
      ];
      const body = lines.map((line) => JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", ...line })).join("\n");
      await writeFile(file_path, `${body}\nnot-json\n\n`, "utf8");
      const messages = await read_session_messages(file_path);
      expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
      expect(JSON.stringify(messages)).not.toContain("injected");
      expect(JSON.stringify(messages)).not.toContain("case");
      expect(JSON.stringify(messages)).not.toContain("missing-role");
      expect(messages[2]).toMatchObject({ role: "tool", tool_call_id: "c1", content: "kept-tool" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
