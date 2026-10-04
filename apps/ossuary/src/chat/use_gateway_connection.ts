/** Subscribe to gateway connection status for the Chat pane. */
import { useEffect, useState } from "react";
import { get_connection_info, on_connection, type ConnectionInfo } from "../gateway-client";

export function use_gateway_connection(): ConnectionInfo {
  const [connection, set_connection] = useState<ConnectionInfo>({ status: "connecting" });
  useEffect(() => {
    void get_connection_info().then(set_connection);
    return on_connection(set_connection);
  }, []);
  return connection;
}
