/** Loopback static server for Vite renderer — Dockview needs http://127.0.0.1 (#93). */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

export interface RendererServer {
  origin: string;
  close: () => Promise<void>;
}

function resolve_safe(root: string, url_path: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(url_path.split("?")[0] ?? "/");
  } catch {
    return null;
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\//, "");
  const full = path.normalize(path.join(root, relative));
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return full === root || full.startsWith(prefix) ? full : null;
}

function host_allowed(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  return host === `127.0.0.1:${port}`;
}

/** Serve `root_dir` on `http://127.0.0.1:<ephemeral>`. */
export async function start_renderer_server(root_dir: string): Promise<RendererServer> {
  const root = path.resolve(root_dir);
  let bound_port = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        if (host_allowed(req, bound_port) === false) {
          res.writeHead(403).end();
          return;
        }
        const file = resolve_safe(root, req.url ?? "/");
        if (file === null || (await stat(file)).isFile() === false) {
          res.writeHead(file === null ? 403 : 404).end();
          return;
        }
        res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
        res.end(await readFile(file));
      } catch {
        res.writeHead(404).end();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("renderer server has no TCP address");
  bound_port = addr.port;
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
