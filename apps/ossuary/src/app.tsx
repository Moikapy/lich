import { useEffect, useState } from "react";
import {
  fetch_health,
  get_connection_info,
  on_connection,
  type ConnectionInfo,
  type HealthResult,
} from "./gateway-client";

export function App() {
  const [connection, set_connection] = useState<ConnectionInfo>({ status: "connecting" });
  const [health, set_health] = useState<HealthResult | undefined>();
  const [health_error, set_health_error] = useState<string | undefined>();

  useEffect(() => {
    void get_connection_info().then(set_connection);
    return on_connection(set_connection);
  }, []);

  useEffect(() => {
    if (connection.status !== "connected") {
      return;
    }
    let cancelled = false;
    void fetch_health()
      .then((result) => {
        if (cancelled === false) {
          set_health(result);
          set_health_error(undefined);
        }
      })
      .catch((error: unknown) => {
        if (cancelled === false) {
          set_health_error(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connection.status]);

  return (
    <main className="hello">
      <h1>ossuary</h1>
      <p className="status" data-testid="connection-status">
        {format_connection(connection)}
      </p>
      {health !== undefined ? (
        <p className="health" data-testid="health-result">
          health: {health.status} · v{health.version}
        </p>
      ) : null}
      {health_error !== undefined ? (
        <p className="error" data-testid="health-error">
          {health_error}
        </p>
      ) : null}
    </main>
  );
}

function format_connection(info: ConnectionInfo): string {
  if (info.status === "connected") {
    return info.port !== undefined ? `connected · port ${info.port}` : "connected";
  }
  if (info.status === "error") {
    return info.error !== undefined ? `error: ${info.error}` : "error";
  }
  return info.status;
}
