/** Same-origin `/popout.html` allowlist for Electron `setWindowOpenHandler`. */

export const POPOUT_PATH = "/popout.html";

/**
 * True when `request_url` is loopback http, matches `renderer_origin`, and
 * targets `/popout.html` only (Dockview popout spike — #93).
 */
export function is_allowed_popout_url(request_url: string, renderer_origin: string): boolean {
  try {
    const request = new URL(request_url);
    const origin = new URL(renderer_origin);
    return (
      request.protocol === "http:" &&
      request.hostname === "127.0.0.1" &&
      request.origin === origin.origin &&
      request.pathname === POPOUT_PATH
    );
  } catch {
    return false;
  }
}
