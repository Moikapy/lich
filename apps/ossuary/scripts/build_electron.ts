import { mkdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out_dir = path.join(root, "dist/electron");

await mkdir(out_dir, { recursive: true });

const main = await Bun.build({
  entrypoints: [path.join(root, "electron/main.ts")],
  outdir: out_dir,
  target: "node",
  format: "esm",
  naming: "main.js",
  external: ["electron"],
});

if (!main.success) {
  console.error(main.logs);
  process.exit(1);
}

const preload = await Bun.build({
  entrypoints: [path.join(root, "electron/preload.ts")],
  outdir: out_dir,
  target: "node",
  format: "cjs",
  naming: "preload.cjs",
  external: ["electron"],
});

if (!preload.success) {
  console.error(preload.logs);
  process.exit(1);
}

console.log("electron main + preload built → dist/electron/");
