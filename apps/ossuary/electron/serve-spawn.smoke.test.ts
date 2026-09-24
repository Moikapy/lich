/**
 * Smoke: spawn via backend-command helpers, connect WS, call health.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawn_lich_serve } from "./serve-process.js";

const created: string[] = [];
const stops: Array<() => void> = [];

afterEach(async () => {
  while (stops.length > 0) {
    stops.pop()?.();
  }
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("spawn_lich_serve smoke", () => {
  it("boots serve and answers health over ws", async () => {
    const work_dir = await mkdtemp(path.join(os.tmpdir(), "ossuary-serve-"));
    created.push(work_dir);
    await mkdir(path.join(work_dir, ".lich"), { recursive: true });
    await writeFile(
      path.join(work_dir, ".lich", "config.json"),
      JSON.stringify({
        providers: [{ kind: "ollama", name: "local", model: "unused" }],
        work_dir,
        log_level: "error",
      }),
    );

    const repo_root = path.resolve(import.meta.dirname, "../../..");
    const running = await spawn_lich_serve({ repo_root, work_dir });
    stops.push(running.stop);

    expect(running.boot.port).toBeGreaterThan(0);
    expect(running.ws_url).toContain(`:${running.boot.port}/`);

    const health = await rpc_health(running.ws_url);
    expect(health).toMatchObject({ status: "ok" });
    expect(typeof health.version).toBe("string");
  }, 30_000);
});

async function rpc_health(ws_url: string): Promise<{ status: string; version: string }> {
  const ws = new WebSocket(ws_url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 10_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("ws open error"));
    });
  });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("health timeout")), 10_000);
      ws.addEventListener("message", (event) => {
        clearTimeout(timer);
        const body = JSON.parse(String(event.data)) as { result?: { status: string; version: string } };
        if (body.result === undefined) {
          reject(new Error(`unexpected: ${String(event.data)}`));
          return;
        }
        resolve(body.result);
      });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "health", params: {} }));
    });
  } finally {
    ws.close();
  }
}
