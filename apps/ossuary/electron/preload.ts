import { contextBridge, ipcRenderer } from "electron";

export interface OssuaryConnectionInfo {
  status: "connecting" | "connected" | "error" | "stopped";
  port?: number;
  error?: string;
}

type ConnectionHandler = (info: OssuaryConnectionInfo) => void;
type NotificationHandler = (method: string, params: unknown) => void;

/** Preload bridge only — no Node/Agent exposure to the renderer. */
contextBridge.exposeInMainWorld("ossuary", {
  ready: true as const,
  getConnectionInfo: (): Promise<OssuaryConnectionInfo> =>
    ipcRenderer.invoke("ossuary:get-connection") as Promise<OssuaryConnectionInfo>,
  requestGateway: (method: string, params?: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke("ossuary:request-gateway", method, params ?? {}) as Promise<unknown>,
  loadLayout: (): Promise<unknown | null> =>
    ipcRenderer.invoke("ossuary:load-layout") as Promise<unknown | null>,
  saveLayout: (layout: unknown): Promise<void> =>
    ipcRenderer.invoke("ossuary:save-layout", layout) as Promise<void>,
  onConnection: (handler: ConnectionHandler): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, info: OssuaryConnectionInfo): void => {
      handler(info);
    };
    ipcRenderer.on("ossuary:connection", listener);
    return () => {
      ipcRenderer.off("ossuary:connection", listener);
    };
  },
  onNotification: (handler: NotificationHandler): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { method?: unknown; params?: unknown },
    ): void => {
      if (typeof payload?.method === "string") {
        handler(payload.method, payload.params);
      }
    };
    ipcRenderer.on("ossuary:notification", listener);
    return () => {
      ipcRenderer.off("ossuary:notification", listener);
    };
  },
});
