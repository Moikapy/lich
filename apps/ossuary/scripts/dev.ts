import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dev_url = "http://127.0.0.1:5173";

function run(command: string, args: string[], env?: NodeJS.ProcessEnv) {
  return spawn(command, args, {
    cwd: root,
    env: env ?? process.env,
    stdio: "inherit",
  });
}

async function wait_for_url(url: string, timeout_ms = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout_ms) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return;
    } catch {
      // vite not ready yet
    }
    await Bun.sleep(200);
  }
  throw new Error(`timed out waiting for ${url}`);
}

const build = run("bun", ["run", "build:electron"]);
await new Promise<void>((resolve, reject) => {
  build.on("exit", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`build:electron exited ${code}`));
  });
});

const vite = run("bun", ["x", "vite"]);
try {
  await wait_for_url(dev_url);
} catch (err) {
  vite.kill("SIGTERM");
  throw err;
}

const electron = run("bun", ["x", "electron", "."], {
  ...process.env,
  VITE_DEV_SERVER_URL: dev_url,
});

function shutdown(signal: NodeJS.Signals) {
  vite.kill(signal);
  electron.kill(signal);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

electron.on("exit", (code) => {
  vite.kill("SIGTERM");
  process.exit(code ?? 0);
});

vite.on("exit", (code) => {
  if (code && code !== 0) {
    electron.kill("SIGTERM");
    process.exit(code);
  }
});
