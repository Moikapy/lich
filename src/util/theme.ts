import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { logger } from "./log.js";
import { LICH_THEME, type ThemeSpec } from "./lore.js";

const text = z.string().min(1);

export const theme_schema = z.object({
  name: text, agent_name: text, glyph: text, tagline: text,
  welcome: text, goodbye: text, response_label: text, user_label: text,
  phase_labels: z.object({ idle: text, thinking: text, tool: text }),
  notices: z.object({ budget_exhausted: text, compressed: text, sessions: text }),
});

export function fill_template(template: string, vars: Record<string, string | number>): string {
  let filled = template;
  for (const [key, value] of Object.entries(vars)) {
    filled = filled.replaceAll(`{${key}}`, String(value));
  }
  return filled;
}

export function notice_flavor(notice: string): string {
  const start = notice.indexOf(" — ");
  if (start === -1) {
    return "";
  }
  const rest = notice.slice(start + 3);
  const end = rest.indexOf(" (");
  return end === -1 ? rest : rest.slice(0, end);
}

export function load_theme(name: string, themes_dir?: string): ThemeSpec {
  if (name === "lich" || name.length === 0) {
    return LICH_THEME;
  }
  try {
    return read_theme_file(name, themes_dir);
  } catch (error) {
    logger.warn(`theme '${name}' unavailable; using default lich theme`, error);
    return LICH_THEME;
  }
}

function read_theme_file(name: string, themes_dir?: string): ThemeSpec {
  if (path.basename(name) !== name) {
    throw new Error("invalid theme name");
  }
  const root = themes_dir ?? path.join(homedir(), ".lich", "themes");
  const theme: ThemeSpec = theme_schema.parse(JSON.parse(readFileSync(path.join(root, `${name}.json`), "utf8")));
  Object.freeze(theme.phase_labels);
  Object.freeze(theme.notices);
  return Object.freeze(theme);
}
