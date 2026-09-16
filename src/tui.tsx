/**
 * TUI entry: builds the agent from the parsed config and renders the ink app
 * until exit. The CLI dynamic-imports this module for `lich tui`.
 */
import { render } from "ink";
import { create_agent_with_plugins } from "./agent/agent.js";
import type { AgentConfig } from "./agent/config.js";
import { TuiApp } from "./tui/app.js";

export async function run_tui(config: AgentConfig): Promise<number> {
  const agent = await create_agent_with_plugins(config);
  const instance = render(<TuiApp agent={agent} />);
  await instance.waitUntilExit();
  return 0;
}