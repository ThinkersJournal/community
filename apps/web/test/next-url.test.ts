import { describe, expect, it } from "vitest";

import { resolveNext } from "../src/lib/next-url";

/**
 * Open-redirect regression corpus for `resolveNext` (login.astro's `?next=`).
 *
 * ⚠️ THIS IS THE THIRD ATTEMPT AT THIS FUNCTION. Two previous versions shipped
 * and were both exploitable (see src/lib/next-url.ts's header). Every payload
 * below is a REAL bypass of one of them, not a hypothetical. Do not delete a
 * case because it "looks like" another one — `/..//evil.com` and `//evil.com`
 * defeat two DIFFERENT versions of this guard.
 *
 * THE INVARIANT: whatever `resolveNext` returns, handing it to the browser as
 * `Location:` must land on `base`'s origin. `landingOrigin` asserts that the
 * way a browser would — by resolving the returned string against the base,
 * exactly as a browser resolves a `Location` header — rather than by
 * inspecting its spelling. A test that only compared strings would have PASSED
 * the `//evil.com` bug, because "//evil.com" is a perfectly good pathname.
 */

const BASE = new URL("https://good.test/login");

/** Where a browser would actually END UP given `resolveNext`'s return value. */
function landingOrigin(raw: string | null): string {
  return new URL(resolveNext(raw, BASE), BASE).origin;
}

/** Payloads that must NEVER navigate off-origin. */
const HOSTILE = [
  // --- Defeated attempt #2 (parse + origin check, return `pathname + search`).
  // Each normalizes to a pathname beginning "//", which is scheme-relative.
  "/..//evil.com",
  "/.//evil.com",
  "/%2e%2e//evil.com",
  "/a/../..//evil.com",
  "/..//evil.com/phish?a=b",
  "/..//attacker.example/login",
  // --- Defeated attempt #1 (the `/^\/[^/]/` regex).
  "/\\evil.com", // browsers normalize \ -> / in special schemes
  "//evil.com",
  "///evil.com",
  // --- Always-hostile classics.
  "https://evil.com",
  "https://evil.com/phish",
  "javascript:alert(1)", // origin "null"
  "blob:https://good.test/abc", // origin ALIASES ours; only the scheme check catches it
  "https://good.test@evil.com/", // userinfo trick: real host is evil.com
  "http://good.test/x", // right host, WRONG scheme -> different origin
];

/** Legitimate values that must survive intact. */
const SAFE: Array<{ next: string; expectPathAndQuery: string }> = [
  { next: "/", expectPathAndQuery: "/" },
  { next: "/new-post", expectPathAndQuery: "/new-post" },
  {
    next: "/verify-email?token=abc123",
    expectPathAndQuery: "/verify-email?token=abc123",
  },
  // A path that merely LOOKS like a host is fine — it stays a path.
  { next: "/evil.com", expectPathAndQuery: "/evil.com" },
  // Percent-encoded slashes are NOT decoded into path separators.
  { next: "/%2f%2fevil.com", expectPathAndQuery: "/%2f%2fevil.com" },
];

describe("resolveNext — hostile input", () => {
  it.each(HOSTILE)("never navigates off-origin for %j", (next) => {
    expect(landingOrigin(next)).toBe(BASE.origin);
  });

  it.each(HOSTILE)("returns an absolute same-origin URL for %j", (next) => {
    // The returned string must be absolute, so it can never be re-parsed as a
    // scheme-relative URL. This is the property attempt #2 lacked.
    expect(resolveNext(next, BASE)).toMatch(/^https:\/\/good\.test\//);
  });
});

describe("resolveNext — legitimate input", () => {
  it.each(SAFE)(
    "preserves $next as an absolute same-origin URL",
    ({ next, expectPathAndQuery }) => {
      expect(resolveNext(next, BASE)).toBe(
        `${BASE.origin}${expectPathAndQuery}`,
      );
      expect(landingOrigin(next)).toBe(BASE.origin);
    },
  );

  it("keeps the verification token intact for the LOGIN_REQUIRED round-trip", () => {
    // The whole point of `next` — verify-email.astro bounces an unauthenticated
    // user here and must get them back to the SAME still-valid token.
    const next = "/verify-email?token=abc123";
    const resolved = new URL(resolveNext(next, BASE));
    expect(resolved.searchParams.get("token")).toBe("abc123");
    expect(resolved.pathname).toBe("/verify-email");
  });
});

describe("resolveNext — absent / unparseable", () => {
  it("defaults to home when `next` is absent", () => {
    expect(resolveNext(null, BASE)).toBe("https://good.test/");
  });

  it("defaults to home (no throw) on an unparseable value", () => {
    // `new URL` can still throw despite the base (e.g. a bad non-special
    // scheme); the guard must fail closed rather than 500 the login page.
    expect(() => resolveNext("http://[", BASE)).not.toThrow();
    expect(landingOrigin("http://[")).toBe(BASE.origin);
  });
});
