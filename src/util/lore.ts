/**
 * Default lich theme as frozen display data. No loader logic here.
 * Mythology stays in these strings; the system prompt stays myth-free.
 */
export interface ThemeSpec {
  readonly name: string;
  readonly agent_name: string;
  readonly glyph: string;
  readonly tagline: string;
  readonly welcome: string;
  readonly goodbye: string;
  readonly response_label: string;
  readonly user_label: string;
  readonly phase_labels: {
    readonly idle: string;
    readonly thinking: string;
    readonly tool: string;
  };
  readonly notices: {
    readonly budget_exhausted: string;
    readonly compressed: string;
    readonly sessions: string;
  };
}

const phase_labels = Object.freeze({
  idle: "dormant",
  thinking: "deliberating",
  tool: "casting",
});

const notices = Object.freeze({
  budget_exhausted: "budget exhausted — the ritual is spent (turn cap reached)",
  compressed: "context compressed — memories distilled (summary {chars} chars)",
  sessions: "phylacteries ({count}):",
});

export const LICH_THEME: ThemeSpec = Object.freeze({
  name: "lich",
  agent_name: "lich",
  glyph: "⚱",
  tagline: "the agent that will not stay dead",
  welcome: "⚱ lich v{version} — the agent that will not stay dead · {model} ({kind})",
  goodbye: "the lich endures",
  response_label: "lich",
  user_label: "mortal",
  phase_labels,
  notices,
});
