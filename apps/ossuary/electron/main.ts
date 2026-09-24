import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolve_repo_root_from_electron_dir } from "./backend-command.js";
import { GatewaySession, type GatewayConnectionInfo } from "./gateway-session.js";
import { assert_gateway_method, is_allowed_sender_url } from "./ipc-policy.js";
import { read_layout_file, write_layout_file } from "./layout_store.js";
import { spawn_lich_serve, type RunningServe } from "./serve-process.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/** Default UI surface: packaged/dev file load is always this exact page. */
const RENDERER_INDEX_PATH = path.resolve(__dirname, "../renderer/index.html");

/** Future plugin/extension pages may register here; empty until needed. */
function plugin_allowed_file_paths(): readonly string[] {
  return [];
}

function allowed_file_paths(): Set<string> {
  return new Set([RENDERER_INDEX_PATH, ...plugin_allowed_file_paths()]);
}

function allowed_origins(): Set<string> {
  const origins = new Set<string>();
  if (!app.isPackaged) {
    const dev_url = process.env.VITE_DEV_SERVER_URL;
    if (dev_url) {
      try {
        origins.add(new URL(dev_url).origin);
      } catch {
        // ignore invalid env
      }
    }
  }
  return origins;
}

function is_allowed_file_navigation(url: string): boolean {
  try {
    const file_path = path.resolve(fileURLToPath(url));
    return allowed_file_paths().has(file_path);
  } catch {
    return false;
  }
}

function is_allowed_navigation(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") {
      return is_allowed_file_navigation(url);
    }
    return allowed_origins().has(parsed.origin);
  } catch {
    return false;
  }
}

function is_allowed_ipc_sender(url: string | undefined): boolean {
  return is_allowed_sender_url(url, is_allowed_navigation);
}

let main_window: BrowserWindow | undefined;
let running_serve: RunningServe | undefined;
let gateway: GatewaySession | undefined;
let last_connection_info: GatewayConnectionInfo = { status: "connecting" };
let on_serve_exit: (() => void) | undefined;
let work_dir = "";

function publish_connection(info: GatewayConnectionInfo): void {
  last_connection_info = info;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("ossuary:connection", info);
  }
}

function create_window(): BrowserWindow {
  const win = new BrowserWindow({
    width: 960,
    height: 640,
    title: "ossuary",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!is_allowed_navigation(url)) {
      event.preventDefault();
    }
  });

  const dev_url = process.env.VITE_DEV_SERVER_URL;
  if (dev_url && !app.isPackaged) {
    void win.loadURL(dev_url);
  } else {
    void win.loadFile(RENDERER_INDEX_PATH);
  }
  return win;
}

function register_ipc(): void {
  ipcMain.handle("ossuary:get-connection", (event: IpcMainInvokeEvent) => {
    if (is_allowed_ipc_sender(event.senderFrame?.url) === false) {
      throw new Error("connection read from disallowed frame");
    }
    return gateway?.get_info() ?? last_connection_info;
  });
  ipcMain.handle(
    "ossuary:request-gateway",
    async (event: IpcMainInvokeEvent, method: unknown, params: unknown) => {
      if (is_allowed_ipc_sender(event.senderFrame?.url) === false) {
        throw new Error("gateway request from disallowed frame");
      }
      if (typeof method !== "string" || method.length === 0) {
        throw new Error("method must be a non-empty string");
      }
      assert_gateway_method(method);
      if (gateway === undefined) {
        throw new Error("gateway not ready");
      }
      const body =
        params !== undefined &&
        typeof params === "object" &&
        params !== null &&
        Array.isArray(params) === false
          ? (params as Record<string, unknown>)
          : {};
      return gateway.request(method, body);
    },
  );
  ipcMain.handle("ossuary:load-layout", async (event: IpcMainInvokeEvent) => {
    if (is_allowed_ipc_sender(event.senderFrame?.url) === false) {
      throw new Error("layout load from disallowed frame");
    }
    if (work_dir.length === 0) {
      return null;
    }
    return read_layout_file(work_dir);
  });
  ipcMain.handle("ossuary:save-layout", async (event: IpcMainInvokeEvent, layout: unknown) => {
    if (is_allowed_ipc_sender(event.senderFrame?.url) === false) {
      throw new Error("layout save from disallowed frame");
    }
    if (work_dir.length === 0) {
      throw new Error("work_dir not ready");
    }
    if (layout === null || typeof layout !== "object" || Array.isArray(layout)) {
      throw new Error("layout must be a plain object");
    }
    await write_layout_file(work_dir, layout);
  });
}

function wire_gateway_notifications(session: GatewaySession): void {
  session.subscribe((method, params) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("ossuary:notification", { method, params });
    }
  });
}

function wire_serve_exit(child: RunningServe["child"]): void {
  on_serve_exit = () => {
    on_serve_exit = undefined;
    gateway?.close();
    gateway = undefined;
    running_serve = undefined;
    publish_connection({ status: "stopped" });
  };
  child.once("exit", on_serve_exit);
}

function default_work_dir(repo_root: string): string {
  if (process.env.LICH_WORK_DIR) {
    return process.env.LICH_WORK_DIR;
  }
  if (app.isPackaged) {
    return app.getPath("userData");
  }
  return repo_root;
}

async function start_backend(): Promise<void> {
  const repo_root = resolve_repo_root_from_electron_dir(__dirname);
  work_dir = default_work_dir(repo_root);
  running_serve = await spawn_lich_serve({ repo_root, work_dir });
  wire_serve_exit(running_serve.child);
  gateway = new GatewaySession();
  wire_gateway_notifications(gateway);
  await gateway.connect(running_serve.ws_url, running_serve.boot.port);
  publish_connection(gateway.get_info());
}

function stop_backend(): void {
  if (running_serve !== undefined && on_serve_exit !== undefined) {
    running_serve.child.off("exit", on_serve_exit);
    on_serve_exit = undefined;
  }
  gateway?.close();
  gateway = undefined;
  running_serve?.stop();
  running_serve = undefined;
}

app.whenReady().then(async () => {
  register_ipc();
  main_window = create_window();
  try {
    await start_backend();
  } catch (error) {
    stop_backend();
    const message = error instanceof Error ? error.message : String(error);
    publish_connection({
      status: "error",
      error: message,
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      main_window = create_window();
    }
  });
});

app.on("before-quit", () => {
  stop_backend();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
