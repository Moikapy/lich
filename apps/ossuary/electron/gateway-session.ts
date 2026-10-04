/**
 * Main-process WebSocket JSON-RPC session to `lich serve`.
 * Token stays out of the renderer; preload exposes requestGateway only.
 */
export type GatewayNotificationHandler = (method: string, params: unknown) => void;

export interface GatewayConnectionInfo {
  status: "connecting" | "connected" | "error" | "stopped";
  port?: number;
  error?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class GatewaySession {
  private ws: WebSocket | undefined;
  private next_id = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<GatewayNotificationHandler>();
  private info: GatewayConnectionInfo = { status: "connecting" };

  get_info(): GatewayConnectionInfo {
    return { ...this.info };
  }

  async connect(ws_url: string, port: number): Promise<void> {
    this.info = { status: "connecting", port };
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(ws_url);
      this.ws = ws;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("gateway websocket connect timeout"));
      }, 10_000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        this.info = { status: "connected", port };
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        this.info = { status: "error", port, error: "websocket error" };
        reject(new Error("gateway websocket error"));
      });
      ws.addEventListener("message", (event) => {
        this.on_message(String(event.data));
      });
      ws.addEventListener("close", () => {
        this.fail_pending("gateway websocket closed");
        if (this.info.status === "connected") {
          this.info = { status: "stopped", port };
        }
      });
    });
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const ws = this.ws;
    if (ws === undefined || ws.readyState !== WebSocket.OPEN) {
      throw new Error("gateway not connected");
    }
    const id = this.next_id;
    this.next_id += 1;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      ws.send(payload);
    });
  }

  subscribe(handler: GatewayNotificationHandler): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  close(): void {
    this.fail_pending("gateway closed");
    this.ws?.close();
    this.ws = undefined;
    this.info = { status: "stopped", port: this.info.port };
  }

  private on_message(raw: string): void {
    let message: {
      id?: unknown;
      result?: unknown;
      error?: { message?: unknown };
      method?: unknown;
      params?: unknown;
    };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      return;
    }
    if (typeof message.method === "string" && message.id === undefined) {
      for (const listener of this.listeners) {
        listener(message.method, message.params);
      }
      return;
    }
    if (typeof message.id !== "number") {
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(message.id);
    if (message.error !== undefined) {
      const text =
        typeof message.error.message === "string" ? message.error.message : "rpc error";
      pending.reject(new Error(text));
      return;
    }
    pending.resolve(message.result);
  }

  private fail_pending(reason: string): void {
    for (const [, pending] of this.pending) {
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
