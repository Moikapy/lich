import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { start_renderer_server } from "./renderer_server.js";

const created: string[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("start_renderer_server", () => {
  it("serves index and blank popout.html on loopback http", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ossuary-renderer-"));
    created.push(root);
    await writeFile(path.join(root, "index.html"), "<html><body>main</body></html>\n");
    await writeFile(path.join(root, "popout.html"), "<html><body><main></main></body></html>\n");

    const server = await start_renderer_server(root);
    servers.push(server);
    expect(server.origin.startsWith("http://127.0.0.1:")).toBe(true);

    const index = await fetch(`${server.origin}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("main");

    const popout = await fetch(`${server.origin}/popout.html`);
    expect(popout.status).toBe(200);
    expect(await popout.text()).toContain("<main></main>");
  });

  it("rejects path traversal outside the renderer root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ossuary-renderer-"));
    created.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "index.html"), "ok\n");

    const server = await start_renderer_server(root);
    servers.push(server);
    const port = Number(new URL(server.origin).port);
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/%2e%2e/package.json" },
        (response) => {
          response.resume();
          resolve({ status: response.statusCode ?? 0 });
        },
      );
      req.on("error", reject);
    });
    expect(res.status).toBe(403);
  });

  it("rejects requests with a non-loopback Host header", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ossuary-renderer-"));
    created.push(root);
    await writeFile(path.join(root, "index.html"), "ok\n");
    const server = await start_renderer_server(root);
    servers.push(server);
    const port = Number(new URL(server.origin).port);
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/", headers: { Host: `evil.example:${port}` } },
        (response) => {
          response.resume();
          resolve({ status: response.statusCode ?? 0 });
        },
      );
      req.on("error", reject);
    });
    expect(res.status).toBe(403);
  });
});
