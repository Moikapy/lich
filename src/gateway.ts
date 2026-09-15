/**
 * Messaging gateway surface: the CLI entrypoint delegates here. Internal
 * implementation lives in ./runner.js (see src/gateway/*).
 */
export { run_gateway } from "./gateway/runner.js";