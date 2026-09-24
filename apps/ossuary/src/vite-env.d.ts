/// <reference types="vite/client" />

export {};

declare global {
  interface Window {
    ossuary?: {
      ready: true;
      getConnectionInfo: () => Promise<{
        status: "connecting" | "connected" | "error" | "stopped";
        port?: number;
        error?: string;
      }>;
      requestGateway: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
      loadLayout: () => Promise<unknown | null>;
      saveLayout: (layout: unknown) => Promise<void>;
      onConnection: (
        handler: (info: {
          status: "connecting" | "connected" | "error" | "stopped";
          port?: number;
          error?: string;
        }) => void,
      ) => () => void;
      onNotification: (handler: (method: string, params: unknown) => void) => () => void;
    };
  }
}
