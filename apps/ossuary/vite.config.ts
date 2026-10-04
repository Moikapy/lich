import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const src = path.resolve(import.meta.dirname, "src");

export default defineConfig({
  root: src,
  // Absolute base so Dockview `/popout.html` stays same-origin on http://127.0.0.1
  base: "/",
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/renderer"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.join(src, "index.html"),
        popout: path.join(src, "popout.html"),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});
