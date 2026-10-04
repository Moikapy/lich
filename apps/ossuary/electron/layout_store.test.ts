import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LAYOUT_FILE_NAME,
  read_layout_file,
  resolve_layout_path,
  write_layout_file,
} from "./layout_store.js";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp_work(): Promise<string> {
  const work = await mkdtemp(path.join(os.tmpdir(), "ossuary-layout-"));
  created.push(work);
  return work;
}

describe("layout_store", () => {
  it("resolves .lich/ossuary-layout.json under work_dir", () => {
    expect(resolve_layout_path("/tmp/work")).toBe(
      path.join("/tmp/work", ".lich", LAYOUT_FILE_NAME),
    );
  });

  it("returns null when the layout file is missing", async () => {
    const work = await temp_work();
    expect(await read_layout_file(work)).toBeNull();
  });

  it("returns null for corrupt JSON", async () => {
    const work = await temp_work();
    const file = resolve_layout_path(work);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{not-json", "utf8");
    expect(await read_layout_file(work)).toBeNull();
  });

  it("round-trips a layout object", async () => {
    const work = await temp_work();
    const layout = { grid: { width: 1 }, panels: { "lich.chat": { id: "lich.chat" } } };
    await write_layout_file(work, layout);
    expect(await read_layout_file(work)).toEqual(layout);
    const text = await readFile(resolve_layout_path(work), "utf8");
    expect(text.trim()).toBe(JSON.stringify(layout));
  });
});
