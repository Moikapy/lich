/**
 * Input row: printable characters accumulate in a buffer, Enter submits,
 * Backspace/Delete edits, Up/Down walk a 20-entry recall ring, and pasted
 * newlines collapse to spaces. Ctrl+C is left to ink's default handling.
 */
import { useState } from "react";
import { Box, Text, useInput } from "ink";

const INPUT_HISTORY_CAP = 20;

interface CommandBarProps {
  readonly busy: boolean;
  readonly on_submit: (text: string) => void;
}

/** Push onto a capped ring (newest first) without mutating the source. */
function push_history(ring: readonly string[], entry: string): readonly string[] {
  return [entry, ...ring.filter((item) => item !== entry)].slice(0, INPUT_HISTORY_CAP);
}

export function CommandBar({ busy, on_submit }: CommandBarProps): React.JSX.Element {
  const [buffer, set_buffer] = useState("");
  const [recall_ring, set_recall_ring] = useState<readonly string[]>([]);
  const [recall_index, set_recall_index] = useState<number | undefined>(undefined);

  const submit_buffer = (): void => {
    if (busy === true) {
      return;
    }
    const text = buffer.trim();
    set_buffer("");
    set_recall_index(undefined);
    if (text.length > 0) {
      set_recall_ring((current) => push_history(current, text));
      on_submit(text);
    }
  };

  /** Newest-first ring: Up walks toward older (higher index), Down toward newer. */
  const walk_recall = (direction: 1 | -1): void => {
    if (recall_ring.length === 0) {
      return;
    }
    if (direction === -1 && recall_index === 0) {
      set_recall_index(undefined);
      set_buffer("");
      return;
    }
    if (direction === -1 && recall_index === undefined) {
      return;
    }
    const current = recall_index ?? -direction;
    const next = Math.min(Math.max(current + direction, 0), recall_ring.length - 1);
    set_recall_index(next);
    set_buffer(recall_ring[next] ?? "");
  };

  useInput((input, key) => {
    if (key.return === true) {
      submit_buffer();
      return;
    }
    if (key.upArrow === true) {
      walk_recall(1);
      return;
    }
    if (key.downArrow === true) {
      walk_recall(-1);
      return;
    }
    if (key.backspace === true || key.delete === true) {
      set_buffer((current) => current.slice(0, -1));
      return;
    }
    if (key.ctrl === true || key.escape === true || key.tab === true || key.meta === true) {
      return;
    }
    if (input.length > 0) {
      set_buffer((current) => current + input.replaceAll("\n", " ").replaceAll("\r", " "));
    }
  });

  return (
    <Box>
      <Text dimColor>{busy ? "  … " : "› "}</Text>
      <Text>{buffer}</Text>
      <Text dimColor>▌</Text>
    </Box>
  );
}
