import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
    server: {
      deps: {
        // Inline zod so vite transforms it instead of the native ESM loader,
        // which fails on gvfs mount paths containing encoded slash characters.
        inline: ["zod"],
      },
    },
  },
});