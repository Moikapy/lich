import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

  const dev_url = process.env.VITE_DEV_SERVER_URL;
  if (dev_url) {
    void win.loadURL(dev_url);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
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
