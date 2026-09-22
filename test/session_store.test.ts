import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { open_session } from "../src/session/store.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

describe("open_session", () => {
  it("embeds pid and random entropy in the session id and creates wx-exclusive files", async () => {
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
      const info = await stat(a.path);
      expect(info.isFile()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
