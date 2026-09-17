const PROTOCOL_VERSION = "2024-11-05";

export function init_params(): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "lich", version: "1" },
  };
}

export function assert_handshake(result: unknown): void {
  if (typeof result !== "object" || result === null) {
    throw new Error("mcp handshake rejected");
  }
  const body = result as { protocolVersion?: unknown; serverInfo?: { name?: unknown } };
  if (typeof body.protocolVersion !== "string" || body.protocolVersion.length === 0) {
    throw new Error("mcp handshake rejected");
  }
  if (typeof body.serverInfo?.name !== "string" || body.serverInfo.name.length === 0) {
    throw new Error("mcp handshake rejected");
  }
}
