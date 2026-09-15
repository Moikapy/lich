/**
 * Fixture plugin exported under a named `plugin` export (loader shape test).
 */
import type { Plugin } from "../../../src/plugins/types.js";

export const plugin: Plugin = {
  name: "named",
  hooks: {
    on_run_start: async () => undefined,
  },
};