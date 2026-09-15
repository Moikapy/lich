/**
 * Root ink component for the lich TUI: wires agent events into the UI state
 * machine, drives agent.run with history continuity, and lays out header,
 * transcript, status bar, and the command input row.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Box, Text } from "ink";
import type { Agent, AgentRunResult } from "../agent/agent.js";
import type { AgentEvent } from "../agent/events.js";
import type { AgentConfig } from "../agent/config.js";
import type { Message } from "../providers/types.js";
import { readdir, stat } from "node:fs/promises";
import {
  apply_event,
  apply_run_result,
  compress_notice_block,
  error_notice_block,
  help_block,
  HISTORY_CAP,
  INITIAL_UI_STATE,
  model_label_block,
  parse_command,
  run_notice_blocks,
  session_list_block,
  tool_result_block,
  unknown_command_block,
  usage_notice_block,
  type HistoryBlock,
  type ParsedInput,
  type SessionEntryInfo,
  type UiState,
} from "./state.js";
import { MessageView } from "./message_view.js";
import { StatusBar } from "./status_bar.js";
import { CommandBar } from "./command_bar.js";

const SESSION_LIST_CAP = 10;

type SlashInput = Extract<ParsedInput, { kind: "slash" }>;
type AddBlocks = (added: readonly HistoryBlock[]) => void;
type SetUiState = Dispatch<SetStateAction<UiState>>;
type SetBlocks = Dispatch<SetStateAction<readonly HistoryBlock[]>>;

/** Map one agent event to optional transcript blocks (tool rows, notices). */
function event_blocks(event: AgentEvent): readonly HistoryBlock[] {
  if (event.type === "tool_call_end") {
    return [tool_result_block(event.call, event.result.ok === true, event.result.output)];
  }
  if (event.type === "compress_end") {
    return [compress_notice_block(event.summary_chars)];
  }
  if (event.type === "error") {
    return [error_notice_block(event.error instanceof Error ? event.error.message : String(event.error))];
  }
  return [];
}

/** One agent turn: subscribe to events, run, unsubscribe in finally. */
async function run_agent_turn(
  agent: Agent,
  history: readonly Message[],
  input: string,
  on_event: (event: AgentEvent) => void,
  on_done: (result: AgentRunResult) => void,
  signal: AbortSignal,
): Promise<void> {
  const stop_listening = agent.events.on(on_event);
  try {
    const result = await agent.run({ input, history, signal, label: "tui" });
    on_done(result);
  } finally {
    stop_listening();
  }
}

/** Async /sessions listing as a meta block (never throws). */
async function sessions_block(config: AgentConfig): Promise<HistoryBlock> {
  try {
    const dir_entries = await readdir(config.session_dir, { withFileTypes: true });
    const entries: SessionEntryInfo[] = [];
    for (const entry of dir_entries) {
      if (entry.isFile() === false || entry.name.endsWith(".jsonl") === false) {
        continue;
      }
      const info = await stat(`${config.session_dir}/${entry.name}`);
      entries.push({ name: entry.name, size_bytes: info.size, mtime_ms: info.mtimeMs });
    }
    return session_list_block(entries, SESSION_LIST_CAP);
  } catch {
    return { role: "meta", lines: ["· no session files yet"] };
  }
}

function run_error_text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs one message exchange; owns history continuity and abort wiring. */
function use_agent_run(
  agent: Agent,
  add_blocks: AddBlocks,
  set_state: SetUiState,
  set_blocks: SetBlocks,
): (text: string) => void {
  const history_ref = useRef<readonly Message[]>([]);
  const controller_ref = useRef<AbortController | undefined>(undefined);

  const finish_run = useCallback((result: AgentRunResult): void => {
    history_ref.current = result.messages;
    set_state((current) => apply_run_result(current, result));
    add_blocks(run_notice_blocks(result));
  }, [add_blocks, set_state]);

  const start_message_run = useCallback(
    (text: string): void => {
      add_blocks([{ role: "user", lines: [`you › ${text}`] }]);
      set_state((current) => ({ ...current, phase: "thinking", active_tool: undefined }));
      const controller = new AbortController();
      controller_ref.current = controller;
      const on_event = (event: AgentEvent): void => {
        set_state((current) => apply_event(current, event));
        set_blocks((current) => [...current, ...event_blocks(event)].slice(-HISTORY_CAP));
      };
      void run_agent_turn(agent, history_ref.current, text, on_event, finish_run, controller.signal)
        .catch((error: unknown) => {
          add_blocks([error_notice_block(run_error_text(error))]);
          set_state((current) => ({ ...current, phase: "idle" }));
        })
        .finally(() => {
          if (controller_ref.current === controller) {
            controller_ref.current = undefined;
          }
        });
    },
    [agent, add_blocks, finish_run, set_blocks, set_state],
  );

  useEffect(() => () => controller_ref.current?.abort(), []);

  return start_message_run;
}

/** Slash-command dispatch: pure client-side actions, never hits the agent. */
function use_slash_commands(agent: Agent, add_blocks: AddBlocks, set_blocks: SetBlocks, total_tokens: number): (parsed: SlashInput) => void {
  const handle = useCallback(
    (parsed: SlashInput): void => {
      if (parsed.name === "exit" || parsed.name === "quit" || parsed.name === "q") {
        process.exit(0);
        return;
      }
      if (parsed.name === "help") {
        add_blocks([help_block()]);
      } else if (parsed.name === "model") {
        add_blocks([model_label_block(agent.config)]);
      } else if (parsed.name === "usage") {
        add_blocks([usage_notice_block(total_tokens)]);
      } else if (parsed.name === "clear") {
        set_blocks([]);
      } else if (parsed.name === "sessions") {
        void sessions_block(agent.config).then((block) => add_blocks([block]));
      } else {
        add_blocks([unknown_command_block(parsed.name)]);
      }
    },
    [agent, add_blocks, set_blocks, total_tokens],
  );
  return handle;
}

interface TuiAppProps {
  readonly agent: Agent;
}

export function TuiApp({ agent }: TuiAppProps): React.JSX.Element {
  const [blocks, set_blocks] = useState<readonly HistoryBlock[]>([]);
  const [state, set_state] = useState(INITIAL_UI_STATE);

  const add_blocks = useCallback<AddBlocks>((added: readonly HistoryBlock[]): void => {
    if (added.length === 0) {
      return;
    }
    set_blocks((current) => [...current, ...added].slice(-HISTORY_CAP));
  }, []);

  const start_message_run = use_agent_run(agent, add_blocks, set_state, set_blocks);
  const handle_slash = use_slash_commands(agent, add_blocks, set_blocks, state.usage.total_tokens);

  const submit = useCallback(
    (text: string): void => {
      const parsed = parse_command(text);
      if (parsed.kind === "message") {
        if (parsed.text.length > 0) {
          start_message_run(parsed.text);
        }
        return;
      }
      handle_slash(parsed);
    },
    [handle_slash, start_message_run],
  );

  const provider = agent.config.providers[0];
  return (
    <Box flexDirection="column" minHeight={8}>
      <Text dimColor>{`lich v0.2.0 — ${provider?.model ?? "unknown"} (${provider?.kind ?? "unknown"})`}</Text>
      <MessageView blocks={blocks} state={state} />
      <StatusBar state={state} model={provider?.model ?? "unknown"} />
      <CommandBar busy={state.phase !== "idle"} on_submit={submit} />
    </Box>
  );
}