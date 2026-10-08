/**
 * The device cookie on the api's response path (security-alerting spec §4.1).
 * A well-formed `__Host-tj_device` (dev/CI: `tj_device_dev`) is reused; anything
 * else gets a fresh 32-byte token minted on the response. Nothing here is
 * awaited on I/O: a cookie read, and at most one more `Set-Cookie`.
 */
import { buildDeviceCookie, CLIENT_COUNTRY_HEADER, DEV_DEVICE_COOKIE, DEVICE_COOKIE } from "@thinkersjournal/shared";

import { base64urlEncode } from "../auth/encoding";

/** 32 bytes, base64url without padding. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;

export interface DeviceCookie {
  /** The browser's token: the one it sent, or the one minted now. */
  readonly token: string;
  /** The `Set-Cookie` value to add, or null when the browser already holds a good one. */
  readonly setCookie: string | null;
}

/** The cookie name this environment uses: the same `TEST_ROUTES === "1"` gate as the session cookie. */
export function deviceCookieName(env: { readonly TEST_ROUTES?: string }): string {
  return env.TEST_ROUTES === "1" ? DEV_DEVICE_COOKIE : DEVICE_COOKIE;
}

/** The well-formed token on `request`, or null. A malformed value is treated as absent. */
export function readDeviceToken(request: Request, env: { readonly TEST_ROUTES?: string }): string | null {
  const header = request.headers.get("Cookie");
  if (header === null) return null;
  const name = deviceCookieName(env);
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1 || trimmed.slice(0, eq) !== name) continue;
    const value = trimmed.slice(eq + 1);
    return TOKEN_RE.test(value) ? value : null;
  }
  return null;
}

export function deviceCookieFor(request: Request, env: { readonly TEST_ROUTES?: string }): DeviceCookie {
  const existing = readDeviceToken(request, env);
  if (existing !== null) return { token: existing, setCookie: null };
  const token = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  return { token, setCookie: buildDeviceCookie(env, token) };
}

/** The session cookie, then the device cookie when one is minted: two distinct `Set-Cookie` headers. */
export function sessionAndDeviceHeaders(sessionCookie: string, device: DeviceCookie | null, json: boolean): Headers {
  const headers = new Headers();
  if (json) headers.set("content-type", "application/json");
  headers.append("Set-Cookie", sessionCookie);
  if (device !== null && device.setCookie !== null) headers.append("Set-Cookie", device.setCookie);
  return headers;
}

/** The edge's country for the original request, or null (`XX`, Cloudflare's "unknown", included; M-3). Never an IP (§4.2). */
export function clientCountry(request: Request): string | null {
  const value = request.headers.get(CLIENT_COUNTRY_HEADER) ?? request.headers.get("CF-IPCountry");
  return value !== null && COUNTRY_RE.test(value) && value !== "XX" ? value : null;
}
