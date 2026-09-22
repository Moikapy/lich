/**
 * TUI entry: builds the agent from the parsed config and renders the ink app
 * until exit. The CLI dynamic-imports this module for `lich tui`.
 */
import { render } from "ink";
import { create_agent_with_plugins } from "./agent/agent.js";
import type { AgentConfig } from "./agent/config.js";
import type { Message } from "./providers/types.js";
import { open_session } from "./session/store.js";
import { TuiApp } from "./tui/app.js";
import { load_theme } from "./util/theme.js";
import { logger } from "./util/log.js";

export interface RunTuiOptions {
  readonly initial_history?: readonly Message[];
  readonly resumed_id?: string;
}

export async function run_tui(config: AgentConfig, options: RunTuiOptions = {}): Promise<number> {
  const agent = await create_agent_with_plugins(config);
  try {
    const theme = load_theme(config.theme);
    const session = await open_session(config.session_dir, "tui").catch((error: unknown) => {
      logger.warn("session persistence failed; continuing without transcript", error);
      return undefined;
    });
    const instance = render(
      <TuiApp
        agent={agent}
        theme={theme}
        session={session}
        initial_history={options.initial_history}
        resumed_id={options.resumed_id}
      />,
    );
    await instance.waitUntilExit();
    return 0;
  } finally {
    agent.close();
  }
}
