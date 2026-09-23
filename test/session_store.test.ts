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
});
