import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function create_window(): void {
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
}

app.whenReady().then(() => {
  create_window();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      create_window();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
