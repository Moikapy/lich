/**
 * resolve_session_path: latest by mtime, exact id, unique prefix, errors.
 */
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolve_session_path } from "../src/session/resolve.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const created: string[] = [];

async function make_session_dir(): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(path.join(TMP_BASE, "session-resolve-"));
  created.push(dir);
  return dir;
}

async function touch_jsonl(dir: string, id: string, mtime_sec: number): Promise<void> {
  const file_path = path.join(dir, `${id}.jsonl`);
  await writeFile(file_path, "", "utf8");
  await utimes(file_path, mtime_sec, mtime_sec);
}

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("resolve_session_path", () => {
  it("resolves latest to the newest .jsonl by mtime", async () => {
    const dir = await make_session_dir();
    await touch_jsonl(dir, "old-1", 100);
    await touch_jsonl(dir, "new-2", 200);
    await touch_jsonl(dir, "mid-3", 150);
    await expect(resolve_session_path(dir, "latest")).resolves.toBe(path.join(dir, "new-2.jsonl"));
  });

  it("resolves an exact session id", async () => {
    const dir = await make_session_dir();
    await touch_jsonl(dir, "m1abc-1-tui", 100);
    await touch_jsonl(dir, "m1abc-2-tui", 200);
    await expect(resolve_session_path(dir, "m1abc-1-tui")).resolves.toBe(path.join(dir, "m1abc-1-tui.jsonl"));
  });

  it("prefers exact id over a longer prefix match", async () => {
    const dir = await make_session_dir();
    await touch_jsonl(dir, "abc", 100);
    await touch_jsonl(dir, "abc-2", 200);
    await expect(resolve_session_path(dir, "abc")).resolves.toBe(path.join(dir, "abc.jsonl"));
  });

  it("resolves a unique filename prefix", async () => {
    const dir = await make_session_dir();
    await touch_jsonl(dir, "m1abc-1-tui", 100);
    await touch_jsonl(dir, "m2def-1-tui", 200);
    await expect(resolve_session_path(dir, "m1abc")).resolves.toBe(path.join(dir, "m1abc-1-tui.jsonl"));
  });

  it("errors when a prefix matches more than one session", async () => {
    const dir = await make_session_dir();
    await touch_jsonl(dir, "abc-1-tui", 100);
    await touch_jsonl(dir, "abc-2-tui", 200);
    await expect(resolve_session_path(dir, "abc")).rejects.toThrow(/ambiguous session prefix.*"abc".*abc-2-tui.*abc-1-tui/);
  });

  it("errors when missing and lists closest candidates by mtime", async () => {
    const dir = await make_session_dir();
    await touch_jsonl(dir, "keep-1", 100);
    await touch_jsonl(dir, "keep-2", 200);
    await expect(resolve_session_path(dir, "missing")).rejects.toThrow(
      /session not found: "missing".*candidates: keep-2, keep-1/,
    );
  });

  it("errors for latest when the session dir is empty and includes dir", async () => {
    const dir = await make_session_dir();
    await expect(resolve_session_path(dir, "latest")).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes(`session not found: "latest" in ${dir}`) && message.includes("candidates: (none)");
    });
  });

  it("propagates non-ENOENT readdir errors", async () => {
    const dir = await make_session_dir();
    const not_a_dir = path.join(dir, "plain-file");
    await writeFile(not_a_dir, "x", "utf8");
    await expect(resolve_session_path(not_a_dir, "latest")).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});
