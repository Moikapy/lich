import { contextBridge } from "electron";

/** Preload bridge only — no Node/Agent exposure to the renderer. */
contextBridge.exposeInMainWorld("ossuary", {
  ready: true as const,
});
