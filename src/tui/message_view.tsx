/**
 * Transcript rendering: a rule and `●` line per user turn, a glyph + label
 * header over each reply, `┊`-guided tool rows, and an animated braille
 * spinner while thinking. Blocks are pre-capped by the app, so a plain flex
 * column is sufficient.
 */
import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { ThemeSpec } from "../util/lore.js";
import { tool_args_summary, type HistoryBlock, type UiState } from "./state.js";

/** Accent for the user's own turns and the input prompt. */
export const USER_ACCENT = "magentaBright";

const SPINNER_FRAMES: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

/** Braille spinner frames on an 80ms interval; clears on unmount. */
function use_spinner(): string {
  const [frame, set_frame] = useState(SPINNER_FRAMES[0] ?? "⠋");
  useEffect(() => {
    const timer = setInterval(() => {
      const next = SPINNER_FRAMES[(SPINNER_FRAMES.indexOf(frame) + 1) % SPINNER_FRAMES.length];
      set_frame(next ?? "⠋");
    }, SPINNER_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [frame]);
  return frame;
}

function ThinkingLine(): React.JSX.Element {
  const frame = use_spinner();
  return <Text dimColor>{`${frame} thinking…`}</Text>;
}

/** The running tool, shaped like the row it becomes once it finishes. */
function RunningToolLine({ name, summary }: { name: string; summary: string }): React.JSX.Element {
  const frame = use_spinner();
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{"┊ "}</Text>
      <Text color="cyan">{summary.length > 0 ? `${frame} ${name}  ${summary}` : `${frame} ${name}`}</Text>
    </Text>
  );
}

/** A full-width dim rule: a box that draws only its top border. */
function Rule(): React.JSX.Element {
  return (
    <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} borderDimColor />
  );
}

/** Tool rows (`✓`/`✗`) get the `┊` guide and stay one line; failed ones are red, the rest cyan. */
function is_tool_row(line: string): boolean {
  return line.startsWith("\u2713 ") || line.startsWith("\u2717 ");
}

function BlockView({ block, theme }: { block: HistoryBlock; theme: ThemeSpec }): React.JSX.Element {
  if (block.role === "user") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Rule />
        {block.lines.map((line, index) => (
          <Text key={index}>
            <Text color={USER_ACCENT}>{"● "}</Text>
            {block.label === undefined ? null : <Text dimColor>{`${block.label}  `}</Text>}
            <Text bold>{line}</Text>
          </Text>
        ))}
      </Box>
    );
  }
  if (block.role === "lich") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="green">{`${theme.glyph} ${block.label ?? theme.response_label}`}</Text>
        <Box flexDirection="column" paddingLeft={2}>
          {block.lines.map((line, index) => (
            <Text key={index}>{line}</Text>
          ))}
        </Box>
      </Box>
    );
  }
  const color = block.role === "error" ? "red" : block.role === "tool" ? "cyan" : undefined;
  return (
    <Box flexDirection="column">
      {block.lines.map((line, index) =>
        is_tool_row(line) ? (
          <Text key={index} wrap="truncate-end">
            <Text dimColor>{"┊ "}</Text>
            <Text color={color}>{line}</Text>
          </Text>
        ) : (
          <Text key={index} color={color} dimColor={color === undefined}>{line}</Text>
        ),
      )}
    </Box>
  );
}

interface MessageViewProps {
  readonly blocks: readonly HistoryBlock[];
  readonly state: UiState;
  readonly theme: ThemeSpec;
}

/** Transcript column plus the live phase line (spinner / running tool row). */
export function MessageView({ blocks, state, theme }: MessageViewProps): React.JSX.Element {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} theme={theme} />
      ))}
      {state.phase === "thinking" ? <ThinkingLine /> : null}
      {state.phase === "tool" && state.active_tool !== undefined ? (
        <RunningToolLine name={state.active_tool.name} summary={tool_args_summary(state.active_tool.args)} />
      ) : null}
    </Box>
  );
}