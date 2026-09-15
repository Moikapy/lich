/**
 * Transcript rendering: maps HistoryBlock descriptors to ink elements with
 * role-based colors, and shows an animated braille spinner while thinking.
 * Blocks are pre-capped by the app, so a plain flex column is sufficient.
 */
import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { tool_args_preview, type HistoryBlock, type UiState } from "./state.js";

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

const ROLE_COLORS: Record<HistoryBlock["role"], string | undefined> = {
  user: "white",
  lich: "green",
  tool: "cyan",
  meta: undefined,
  error: "red",
};

function BlockLines({ block }: { block: HistoryBlock }): React.JSX.Element {
  const color = ROLE_COLORS[block.role];
  return (
    <>
      {block.lines.map((line, index) => (
        <Text key={index} color={color} dimColor={color === undefined}>{line}</Text>
      ))}
    </>
  );
}

interface MessageViewProps {
  readonly blocks: readonly HistoryBlock[];
  readonly state: UiState;
}

/** Transcript column plus the live phase line (spinner / running tool row). */
export function MessageView({ blocks, state }: MessageViewProps): React.JSX.Element {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {blocks.map((block, index) => (
        <Box key={index} flexDirection="column">
          <BlockLines block={block} />
        </Box>
      ))}
      {state.phase === "thinking" ? <ThinkingLine /> : null}
      {state.phase === "tool" && state.active_tool !== undefined ? (
        <Text color="cyan">{`⏺ ${state.active_tool.name}(${tool_args_preview(state.active_tool.args)})`}</Text>
      ) : null}
    </Box>
  );
}