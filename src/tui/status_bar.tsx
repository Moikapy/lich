/**
 * Bottom status line: phase tag, model, turns, token totals, compression
 * count, and the session id once the agent has persisted a transcript.
 */
import path from "node:path";
import { Box, Text } from "ink";
import type { ThemeSpec } from "../util/lore.js";
import { format_usage, type UiPhase, type UiState } from "./state.js";

const PHASE_COLORS: Record<UiPhase, string> = { idle: "gray", thinking: "yellow", tool: "cyan" };

interface StatusBarProps {
  readonly state: UiState;
  readonly model: string;
  readonly theme: ThemeSpec;
}

export function StatusBar({ state, model, theme }: StatusBarProps): React.JSX.Element {
  const phase = theme.phase_labels[state.phase];
  // One Text with nested spans, so a long line wraps as a paragraph; sibling
  // Texts in a row Box would be laid out as side-by-side columns instead.
  return (
    <Box>
      <Text>
        <Text color={PHASE_COLORS[state.phase]}>{phase}</Text>
        <Text dimColor>
          {` · ${model} · turn ${state.turns_used} · ${format_usage(state.usage.total_tokens)} tokens`}
          {state.compress_count > 0 ? ` · compressed ${state.compress_count}` : ""}
          {state.session_path !== undefined ? ` · ${path.basename(state.session_path, ".jsonl")}` : ""}
        </Text>
        {state.budget_exhausted ? <Text color="red">{` · ${theme.notices.budget_exhausted}`}</Text> : null}
      </Text>
    </Box>
  );
}