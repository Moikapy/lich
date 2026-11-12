import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ToolExecutor } from "../src/tools/executor.js";
import { register_builtin_tools } from "../src/tools/builtin/index.js";
import { reset_docs_search_cache } from "../src/tools/builtin/docs_search.js";
import { reset_docs_cache } from "../src/tools/builtin/docs_read.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolResult } from "../src/tools/types.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

/** Package docs so require_docs_root does not fail on a tmp work_dir with no docs/. */
const package_docs = fileURLToPath(new URL("../docs/", import.meta.url));

let tmp_root: string;
let executor: ToolExecutor;

beforeEach(async () => {
  tmp_root = await mkdtemp(path.join(TMP_BASE, "skills-"));
  const registry = new ToolRegistry();
  register_builtin_tools(registry);
  executor = new ToolExecutor(registry);
  reset_docs_search_cache();
  reset_docs_cache();
});

afterEach(async () => {
  reset_docs_search_cache();
  reset_docs_cache();
  await rm(tmp_root, { recursive: true, force: true });
});

async function write_skill(name: string, content: string): Promise<void> {
  const dir = path.join(tmp_root, ".lich", "skills");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), content);
}

function search(query: string): Promise<ToolResult> {
  return executor.execute("docs_search", { query }, { work_dir: tmp_root, env: { LICH_DOCS_DIR: package_docs } });
}

describe("docs_search skills source", () => {
  it("finds a skill written via the .lich/skills convention (no index.md needed)", async () => {
    await write_skill("unique-skill.md", "# unique-skill\n\n## Technique\nThe zzxqskillphrase makes tests pass.\n");
    expect(existsSync(path.join(tmp_root, ".lich", "skills", "index.md"))).toBe(false);
    const result = await search("zzxqskillphrase");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("unique-skill.md");
  });

  it("walks the skills dir fresh on every call (no stale memo)", async () => {
    const first = await search("yymzfirstphrase");
    expect(first.ok).toBe(true);
    expect(first.output).not.toContain("late-skill.md");
    await write_skill("late-skill.md", "# late-skill\n\n## Note\nThe yymzfirstphrase arrives late.\n");
    const second = await search("yymzfirstphrase");
    expect(second.ok).toBe(true);
    expect(second.output).toContain("late-skill.md");
  });

  it("does not index a skill symlink that leaves the skills directory", async () => {
    const outside = path.join(tmp_root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "nested.md"), "# nested\n\n## Hidden\nzqxskilloutside lives here.\n");
    const skills = path.join(tmp_root, ".lich", "skills");
    await mkdir(skills, { recursive: true });
    await symlink(path.join(outside, "nested.md"), path.join(skills, "leak.md"));
    await symlink(outside, path.join(skills, "alias"));
    await writeFile(path.join(skills, "kept.md"), "# kept\n\n## Note\nzqxskillkept stays inside.\n");
    const leaked = await search("zqxskilloutside");
    expect(leaked.ok).toBe(true);
    expect(leaked.output).toBe("no results for: zqxskilloutside");
    const kept = await search("zqxskillkept");
    expect(kept.ok).toBe(true);
    expect(kept.output).toContain("kept.md");
    expect(kept.output).not.toContain("zqxskilloutside");
    expect(kept.output).not.toContain("leak.md");
  });

  it("keeps working when no skills dir exists", async () => {
    const result = await search("agent");
    expect(result.ok).toBe(true);
  });
});
