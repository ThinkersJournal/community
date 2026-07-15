/**
 * Open-redirect guard for `?next=` (login.astro).
 *
 * Extracted from the page and given its own test corpus because this function
 * has ALREADY shipped two different wrong answers (see the WHY below). It is a
 * pure string→string function; it must stay that way, so it can be pinned by
 * `test/next-url.test.ts` without a Worker runtime.
 *
 * WHY IT'S SUBTLE — two failed attempts, both of which "looked" correct:
 *
 *   1. `/^\/[^/]/` ("starts with a single slash"). Broken: `/\evil.com`
 *      satisfies it, but browsers normalize `\` → `/` in special schemes
 *      (WHATWG URL), so it navigates to `//evil.com` → host `evil.com`.
 *
 *   2. Parse against the base, compare `origin`, return `pathname + search`.
 *      The parse and the origin check are RIGHT — the parsed URL genuinely is
 *      same-origin. The RE-SERIALIZATION is what reintroduces the bug:
 *      `new URL("/..//evil.com", "https://good.test/login")` normalizes to
 *      `https://good.test//evil.com`, whose **pathname is `//evil.com`**. Emit
 *      that as `Location: //evil.com` and it is a SCHEME-RELATIVE url — the
 *      browser fills in the scheme and goes to `https://evil.com`. The origin
 *      you just validated is discarded by the very act of returning a relative
 *      string. A whole family escapes this way: `/.//evil.com`,
 *      `/%2e%2e//evil.com`, `/a/../..//evil.com`, `/..//evil.com/phish?a=b`.
 *
 * THE RULE: **return an ABSOLUTE, same-origin URL.** An absolute URL cannot be
 * re-parsed as scheme-relative, so the origin that was validated is the origin
 * the browser uses. Do not "simplify" this back to `pathname + search`;
 * `test/next-url.test.ts` will fail if you do, which is the point.
 */

/**
 * Resolve an untrusted `next` value to a safe absolute URL on `base`'s origin.
 * Anything not provably same-origin — or unparseable, or absent — degrades to
 * `base.origin + "/"`.
 *
 * ⚠️ RESOLVE, don't pattern-match. Any regex here is a guess about the
 * browser's URL parser; running the same parser the browser runs is not a
 * guess.
 */
export function resolveNext(raw: string | null, base: URL): string {
  const home = `${base.origin}/`;

  if (raw === null) {
    return home;
  }

  try {
    const target = new URL(raw, base);

    // Rejects `//evil.com`, `https://evil.com`, `/\evil.com` (normalized to
    // `//evil.com`), `javascript:alert(1)` (origin "null"), and the userinfo
    // trick `https://good.test@evil.com/` (whose real host is evil.com).
    if (target.origin !== base.origin) {
      return home;
    }

    // ⚠️ NOT redundant with the origin check. A `blob:` URL INHERITS the origin
    // of the URL embedded in it, so `blob:https://good.test/abc` has origin
    // `https://good.test` and passes the check above — while its `pathname` is
    // the opaque string `https://good.test/abc`. Pinning the scheme keeps the
    // pathname meaning what the rest of this function assumes it means.
    if (target.protocol !== base.protocol) {
      return home;
    }

    // ⚠️ MUST be absolute — see the file header. `pathname + search` is unsafe:
    // `/..//evil.com` normalizes to pathname `//evil.com`, and
    // `Location: //evil.com` is scheme-relative, i.e. off-origin.
    // The hash is intentionally dropped (nothing needs it, and it is never
    // sent to the server anyway).
    return `${target.origin}${target.pathname}${target.search}`;
  } catch {
    return home;
  }
}
