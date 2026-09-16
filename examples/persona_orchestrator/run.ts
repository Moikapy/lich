/**
 * In-repo entry. Game repo: import { create_agent_with_plugins } from "@moikapy/lich"
 * and keep the rest. This file does not start on import.
 */
import { create_agent_with_plugins } from "../../src/index.js";
import { create_orchestrator } from "./orchestrator.js";
import { PERSONA_TABLE } from "./personas.js";
import { start_persona_server } from "./server.js";
import type { AgentFactory } from "./types.js";

const factory = create_agent_with_plugins as unknown as AgentFactory;

export async function main(): Promise<void> {
  const orchestrator = create_orchestrator({
    factory,
    shared: {
      providers: [{ kind: "ollama", name: "local", model: "llama3.2" }],
      work_dir: process.cwd(),
    },
    personas: PERSONA_TABLE,
  });
  const server = await start_persona_server({ orchestrator, port: 8090 });
  process.stdout.write(`persona orchestrator listening on 127.0.0.1:${server.port}\n`);
}

const is_entry = process.argv[1]?.endsWith("run.ts") === true || process.argv[1]?.endsWith("run.js") === true;
if (is_entry === true) {
  await main();
}
