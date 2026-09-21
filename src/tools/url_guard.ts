/**
 * SSRF guard for HTTP tools: resolve host, reject private/loopback/link-local/ULA,
 * pin the connect to a vetted IP (hostname kept for SNI/TLS), re-validate redirects.
 * Operator opt-out: LICH_ALLOW_PRIVATE_URLS=1.
 */
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { LookupFunction } from "node:net";

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Optional fetch override for tests; otherwise uses pinned http(s).request. */
let fetch_override: typeof fetch | undefined;

/** Replace the fetch used by safe_fetch (test seam). */
export function set_url_guard_fetch(impl: typeof fetch): void {
  fetch_override = impl;
}

/** Clear the fetch override (test seam teardown). */
export function reset_url_guard_fetch(): void {
  fetch_override = undefined;
}

/** True when private-URL opt-out is active for local dev. */
export function private_urls_allowed(): boolean {
  return process.env["LICH_ALLOW_PRIVATE_URLS"] === "1";
}

/** Classify an IPv4 literal as blocked (loopback/link-local/private/CGNAT). */
function is_blocked_ipv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => Number.isFinite(n) === false)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  return a >= 224;
}

/** Classify an IPv6 literal as blocked (loopback/link-local/ULA/v4-mapped). */
function is_blocked_ipv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return net.isIPv4(mapped) === true ? is_blocked_ipv4(mapped) : true;
  }
  const head = Number.parseInt(normalized.split(":")[0] ?? "", 16);
  if (Number.isFinite(head) === false) {
    return true;
  }
  if ((head & 0xffc0) === 0xfe80) {
    return true;
  }
  if ((head & 0xfe00) === 0xfc00) {
    return true;
  }
  return false;
}

/** True for loopback, link-local, private, ULA, and other non-public addresses. */
export function is_blocked_ip(address: string): boolean {
  if (net.isIPv4(address) === true) {
    return is_blocked_ipv4(address);
  }
  if (net.isIPv6(address) === true) {
    return is_blocked_ipv6(address);
  }
  return true;
}

/** Reject non-http(s) URLs (shared with fetch_url.valid_http_url messaging). */
export function parse_http_url(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid_url: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`invalid_url: unsupported protocol ${parsed.protocol}`);
  }
  return parsed;
}

/** Strip IPv6 brackets Node may leave on URL.hostname. */
function normalize_hostname(hostname: string): string {
  if (hostname.startsWith("[") === true && hostname.endsWith("]") === true) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

/** Resolve hostname to a public IP, or throw blocked_url. */
export async function resolve_public_ip(raw_hostname: string): Promise<string> {
  const hostname = normalize_hostname(raw_hostname);
  if (private_urls_allowed() === true) {
    if (net.isIP(hostname) !== 0) {
      return hostname;
    }
    const hit = await dns.lookup(hostname);
    return hit.address;
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error(`blocked_url: ${hostname}`);
  }
  if (net.isIP(hostname) !== 0) {
    if (is_blocked_ip(hostname) === true) {
      throw new Error(`blocked_url: ${hostname}`);
    }
    return hostname;
  }
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0) {
    throw new Error(`blocked_url: ${hostname}`);
  }
  for (const record of records) {
    if (is_blocked_ip(record.address) === true) {
      throw new Error(`blocked_url: ${hostname}`);
    }
  }
  return records[0]?.address ?? hostname;
}

/** Lookup that always returns the already-vetted address (IPv4 or IPv6). */
function pinned_lookup(ip: string): LookupFunction {
  const family = net.isIPv6(ip) === true ? 6 : 4;
  return ((_hostname, options, callback) => {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" ? undefined : options;
    if (typeof cb !== "function") {
      return;
    }
    if (opts !== undefined && opts.all === true) {
      cb(null, [{ address: ip, family }]);
      return;
    }
    cb(null, ip, family);
  }) as LookupFunction;
}

/** Flatten RequestInit headers into a plain object for http.request. */
function request_headers(init: RequestInit | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

/** Body bytes for http.request; strings and Uint8Array only (tool callers). */
function request_body(init: RequestInit | undefined): string | Uint8Array | undefined {
  const body = init?.body;
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === "string" || body instanceof Uint8Array) {
    return body;
  }
  throw new Error("blocked_url: unsupported_body");
}

/**
 * Connect with hostname kept for SNI/Host, but DNS forced to the vetted IP.
 * Does not follow redirects (caller handles Location).
 */
function pinned_http_fetch(url: URL, ip: string, init: RequestInit): Promise<Response> {
  const lib = url.protocol === "https:" ? https : http;
  const method = (init.method ?? "GET").toUpperCase();
  const headers = request_headers(init);
  const body = request_body(init);
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port.length > 0 ? Number(url.port) : undefined,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        lookup: pinned_lookup(ip),
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        incoming.on("end", () => {
          const status = incoming.statusCode ?? 0;
          const response_headers = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (typeof value === "string") {
              response_headers.set(key, value);
            } else if (Array.isArray(value) === true) {
              for (const part of value) {
                response_headers.append(key, part);
              }
            }
          }
          resolve(new Response(Buffer.concat(chunks), { status, headers: response_headers }));
        });
      },
    );
    req.on("error", reject);
    const signal = init.signal;
    if (signal !== undefined && signal !== null) {
      if (signal.aborted === true) {
        req.destroy(new Error("aborted"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          req.destroy(new Error("aborted"));
        },
        { once: true },
      );
    }
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

function redirect_target(current: URL, response: Response): URL | undefined {
  if (REDIRECT_STATUSES.has(response.status) === false) {
    return undefined;
  }
  const location = response.headers.get("location");
  if (location === null || location.length === 0) {
    return undefined;
  }
  return new URL(location, current);
}

/**
 * Fetch with SSRF checks: pin each hop to a public IP, redirect:"manual",
 * re-validate every Location. Opt out with LICH_ALLOW_PRIVATE_URLS=1.
 * HTTPS keeps the original hostname for TLS/SNI; the connect IP is pinned.
 */
export async function safe_fetch(raw_url: string, init?: RequestInit): Promise<Response> {
  let current = parse_http_url(raw_url);
  let request_init: RequestInit = { ...(init ?? {}), redirect: "manual" };
  for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
    const ip = await resolve_public_ip(current.hostname);
    const response =
      fetch_override !== undefined
        ? await fetch_override(current.href, { ...request_init, redirect: "manual" })
        : await pinned_http_fetch(current, ip, request_init);
    const next = redirect_target(current, response);
    if (next === undefined) {
      return response;
    }
    current = next;
    request_init = { ...request_init, method: "GET", body: undefined };
  }
  throw new Error("blocked_url: too_many_redirects");
}
