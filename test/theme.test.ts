import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { set_log_level } from "../src/util/log.js";
import { LICH_THEME } from "../src/util/lore.js";
import { fill_template, load_theme, notice_flavor } from "../src/util/theme.js";
import { TMP_BASE } from "./helpers/tmp_base.js";

const VAMPIRE = {
  name: "vampire",
  agent_name: "vampire",
  glyph: "🦇",
  tagline: "night's clerk, unpaid",
  welcome: "🦇 vampire v{version} — night's clerk, unpaid · {model} ({kind})",
  goodbye: "dawn approaches",
  response_label: "vampire",
  user_label: "mortal",
  phase_labels: { idle: "sleeping", thinking: "scheming", tool: "feeding" },
  notices: {
    budget_exhausted: "budget exhausted — the blood bank is dry (turn cap reached)",
    compressed: "context compressed — memories enthralled (summary {chars} chars)",
    sessions: "coffins ({count}):",
  },
};

const created: string[] = [];

async function themes_dir(): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(path.join(TMP_BASE, "themes-"));
  created.push(dir);
  return dir;
}

async function write_theme(dir: string, name: string, body: unknown): Promise<void> {
  const raw = typeof body === "string" ? body : `${JSON.stringify(body)}\n`;
  await writeFile(path.join(dir, `${name}.json`), raw, "utf8");
}

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("load_theme", () => {
  it("returns the frozen default without reading a lich.json override", async () => {
    const dir = await themes_dir();
    await write_theme(dir, "lich", { ...VAMPIRE, name: "lich", glyph: "X" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(load_theme("lich", dir)).toBe(LICH_THEME);
      expect(load_theme("", dir)).toBe(LICH_THEME);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("loads a valid custom theme and freezes it", async () => {
    const dir = await themes_dir();
    await write_theme(dir, "vampire", VAMPIRE);
    const theme = load_theme("vampire", dir);
    expect(theme.glyph).toBe("🦇");
    expect(theme.notices.sessions).toBe("coffins ({count}):");
    expect(Object.isFrozen(theme)).toBe(true);
    expect(Object.isFrozen(theme.notices)).toBe(true);
    expect(Object.isFrozen(theme.phase_labels)).toBe(true);
  });

  it("falls back with one warning when the file is missing, invalid, or schema-invalid", async () => {
    set_log_level("info");
    const dir = await themes_dir();
    await write_theme(dir, "broken", "{");
    await write_theme(dir, "partial", { name: "partial", glyph: "x" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(load_theme("missing", dir)).toBe(LICH_THEME);
      expect(load_theme("broken", dir)).toBe(LICH_THEME);
      expect(load_theme("partial", dir)).toBe(LICH_THEME);
      expect(load_theme("../nope", dir)).toBe(LICH_THEME);
      const warnings = spy.mock.calls.map((call) => String(call[0]));
      expect(warnings.filter((line) => line.includes("unavailable; using default lich theme"))).toHaveLength(4);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("fill_template", () => {
  it("substitutes placeholders and leaves unknown tokens", () => {
    expect(fill_template(LICH_THEME.welcome, { version: "0.6.0", model: "llama3.2", kind: "ollama" })).toBe(
      "⚱ lich v0.6.0 — the agent that will not stay dead · llama3.2 (ollama)",
    );
    expect(fill_template(LICH_THEME.notices.compressed, { chars: 512 })).toContain("summary 512 chars");
    expect(fill_template("keep {turns}", {})).toBe("keep {turns}");
  });

  it("keeps the greppable budget keyword and exposes the flavor suffix", () => {
    expect(LICH_THEME.notices.budget_exhausted.startsWith("budget exhausted")).toBe(true);
    expect(notice_flavor(LICH_THEME.notices.budget_exhausted)).toBe("the ritual is spent");
    expect(notice_flavor(VAMPIRE.notices.budget_exhausted)).toBe("the blood bank is dry");
  });
});
