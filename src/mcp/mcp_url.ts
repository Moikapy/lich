/** Loopback only. No 0.0.0.0 and no remote host in v1. */
export function refuse_http_url(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "refused mcp url";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "refused mcp url";
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return "refused mcp url credentials";
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost") {
    return "refused mcp url; loopback only";
  }
  return undefined;
}
