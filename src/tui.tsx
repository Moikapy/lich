/**
 * TUI entry: builds the agent from the parsed config and renders the ink app
 * until exit. The CLI dynamic-imports this module for `lich tui`.
 */
import { render } from "ink";
import { create_agent_with_plugins } from "./agent/agent.js";
import type { AgentConfig } from "./agent/config.js";
import { TuiApp } from "./tui/app.js";
import { load_theme } from "./util/theme.js";

export async function run_tui(config: AgentConfig): Promise<number> {
  const agent = await create_agent_with_plugins(config);
  try {
    const theme = load_theme(config.theme);
    const instance = render(<TuiApp agent={agent} theme={theme} />);
    await instance.waitUntilExit();
    return 0;
  } finally {
    agent.close();
  }
}