/**
 * The browser's device cookie, and ONLY that cookie, for the api's login,
 * signup and reset calls (security-alerting spec §4.1; final review C-1).
 *
 * The api recognises a browser it has seen by its `__Host-tj_device` cookie
 * (dev/CI: `tj_device_dev`). A `Service Binding` call carries no cookie of its
 * own, so without this every sign-in looks like a new browser. The rest of the
 * browser's `Cookie` header (the session above all) is deliberately NOT sent:
 * signup is how a session first comes to exist, and login and reset are not
 * built to receive one.
 *
 * Pure (no `cloudflare:workers` import), so the plain-Node vitest can test it.
 * Parsed the way the api's `readDeviceToken` parses it
 * (apps/api/src/security/device-cookie.ts): a malformed value is dropped.
 */
import { DEV_DEVICE_COOKIE, DEVICE_COOKIE } from "@thinkersjournal/shared";

/** 32 bytes, base64url without padding: the only token shape the api accepts. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const NAMES: ReadonlySet<string> = new Set([DEVICE_COOKIE, DEV_DEVICE_COOKIE]);

/** The `Cookie` value to send the api, or null when the browser holds no well-formed device cookie. */
export function deviceCookieOnly(cookieHeader: string | null): string | null {
  if (cookieHeader === null) return null;
  const pairs = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((pair) => {
      const eq = pair.indexOf("=");
      return eq > 0 && NAMES.has(pair.slice(0, eq)) && TOKEN_RE.test(pair.slice(eq + 1));
    });
  return pairs.length === 0 ? null : pairs.join("; ");
}

/**
 * `apiFetch`'s `deviceCookieFrom` option: sets `headers`' Cookie to
 * `deviceCookieOnly(from's Cookie)`, never `from`'s header whole. Leaves a
 * Cookie already set (a `request` forwarded whole) alone.
 */
export function applyDeviceCookie(headers: Headers, from: Request | undefined): void {
  const deviceCookie = deviceCookieOnly(from?.headers.get("Cookie") ?? null);
  if (deviceCookie !== null && !headers.has("Cookie")) headers.set("Cookie", deviceCookie);
}
