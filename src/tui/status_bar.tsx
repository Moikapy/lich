/**
 * Bottom status line: model, turns, token totals, phase tag, compression
 * count, and the session path once the agent has persisted a transcript.
 */
import { Box, Text } from "ink";
import type { ThemeSpec } from "../util/lore.js";
import { format_usage, type UiState } from "./state.js";

interface StatusBarProps {
  readonly state: UiState;
  readonly model: string;
  readonly theme: ThemeSpec;
}

export function StatusBar({ state, model, theme }: StatusBarProps): React.JSX.Element {
  const phase = theme.phase_labels[state.phase];
  return (
    <Box>
      <Text dimColor>
        {`model ${model} · turns ${state.turns_used} · tokens ${format_usage(state.usage.total_tokens)} · [${phase}]`}
        {state.compress_count > 0 ? ` · compressed ${state.compress_count}` : ""}
        {state.session_path !== undefined ? ` · ${state.session_path}` : ""}
      </Text>
      {state.budget_exhausted ? <Text color="red">{` · ${theme.notices.budget_exhausted}`}</Text> : null}
    </Box>
  );
}