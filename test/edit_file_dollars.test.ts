import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { edit_file_tool } from "../src/tools/builtin/edit_file.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe("edit_file dollar replacements (S-10)", () => {
  it("treats $& and $$ literally and allows empty new_string", async () => {
    await mkdir(TMP_BASE, { recursive: true });
    const work = await mkdtemp(path.join(TMP_BASE, "edit-dollar-"));
    dirs.push(work);
    await writeFile(path.join(work, "a.txt"), "pid=OLD");
    const literal = await edit_file_tool.execute(
      { path: "a.txt", old_string: "OLD", new_string: "pid=$$" },
      { work_dir: work, env: {} },
    );
    expect(literal.ok).toBe(true);
    expect(await readFile(path.join(work, "a.txt"), "utf8")).toBe("pid=pid=$$");
    const cleared = await edit_file_tool.execute(
      { path: "a.txt", old_string: "pid=pid=$$", new_string: "" },
      { work_dir: work, env: {} },
    );
    expect(cleared.ok).toBe(true);
    expect(await readFile(path.join(work, "a.txt"), "utf8")).toBe("");
  });
});
