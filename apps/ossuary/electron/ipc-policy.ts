/**
 * Pure IPC policy for the ossuary ↔ serve gateway bridge.
 * Deny-by-default: only methods the renderer actually invokes.
 */
export const GATEWAY_METHOD_ALLOWLIST: ReadonlySet<string> = new Set([
  "health",
  "prompt.abort",
  "prompt.submit",
  "session.clear",
  "session.create",
  "session.list",
  "session.resume",
]);

export function is_allowed_sender_url(
  url: string | undefined,
  is_allowed_navigation: (candidate: string) => boolean,
): boolean {
  if (url === undefined || url.length === 0) {
    return false;
  }
  return is_allowed_navigation(url);
}

export function assert_gateway_method(method: string): void {
  if (GATEWAY_METHOD_ALLOWLIST.has(method) === false) {
    throw new Error(`method not allowed: ${method}`);
  }
}
