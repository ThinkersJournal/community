import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { SessionData } from "@thinkersjournal/shared";

import { checkCsrf, checkOrigin, csrfTokenFor } from "../src/auth/csrf";

/**
 * Real WebCrypto throughout (no mocks) — `crypto.subtle` is a genuine workerd
 * global in this POOL project, so `csrfTokenFor`/`checkCsrf` exercise the real
 * SHA-256 digest + timing-safe compare rather than a stub.
 */

/**
 * `checkOrigin`'s allowlist is `TEST_ROUTES`-gated (src/auth/csrf.ts), so every
 * call needs an `env`. These two stand in for the two deploy states:
 *
 *   • DEV/CI  — `TEST_ROUTES === "1"`: production origins PLUS localhost.
 *   • PROD    — `TEST_ROUTES` unset: production origins ONLY.
 *
 * ⚠️ The suite itself runs with `TEST_ROUTES="1"` (vitest.config.ts's
 * `miniflare.bindings`), so `env` alone can only ever exercise the DEV shape —
 * the PRODUCTION allowlist would go completely untested without `PROD_ENV`.
 * That is the same reason test/session.test.ts pins both cookie modes.
 */
const DEV_ENV = env;
const PROD_ENV = { ...env, TEST_ROUTES: undefined } as unknown as Env;

const sampleSession: SessionData = {
  userId: "11111111-1111-1111-1111-111111111111",
  roles: ["member"],
  securityEpoch: 1,
  csrfSecret: "csrf-secret-value",
  createdAt: Date.now(),
};

function postRequest(headers: Record<string, string>): Request {
  return new Request("https://api.test/some-endpoint", {
    method: "POST",
    headers,
  });
}

/** As `postRequest`, for any method — the allowlist must not be POST-specific. */
function requestWithMethod(
  method: string,
  headers: Record<string, string>,
): Request {
  return new Request("https://api.test/some-endpoint", { method, headers });
}

/**
 * Every non-safe method the allowlist must cover. GET/HEAD are deliberately
 * absent — they are the documented pass-through, pinned separately below.
 */
const UNSAFE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

describe("checkOrigin", () => {
  it("allows a POST from an allowed Origin", () => {
    const request = postRequest({ Origin: "https://community.thinkersjournal.com" });
    expect(checkOrigin(DEV_ENV, request)).toBe(true);
  });

  /**
   * SINGLE-HOST NOW: the app is served only from `community.thinkersjournal.com`.
   * The apex and `www` origins used to be accepted alongside it; they are NOT
   * anymore, and a regression that widened the allowlist back to include them
   * would let a CSRF check pass on a host the app is never served from.
   */
  it.each([
    "https://thinkersjournal.com",
    "https://www.thinkersjournal.com",
  ])("rejects the stale, no-longer-allowed Origin %s", (origin) => {
    const request = postRequest({ Origin: origin });
    expect(checkOrigin(DEV_ENV, request)).toBe(false);
  });

  it("rejects a POST from a disallowed Origin", () => {
    const request = postRequest({ Origin: "https://evil.com" });
    expect(checkOrigin(DEV_ENV, request)).toBe(false);
  });

  /**
   * ⚠️ THE SECURITY-CRITICAL REGRESSION. A present `Origin` is DISPOSITIVE:
   * `checkOrigin` returns on it and must NEVER fall through to `Referer`.
   *
   * Without this case, the disallowed-Origin test above passes trivially — it
   * sends no `Referer`, so a buggy fall-through would find nothing to fall back
   * TO and still return false. The dangerous shape is exactly this one: an
   * attacker's real `Origin` (which a browser sets and script cannot forge)
   * alongside an allowed-looking `Referer` (which is far weaker — it can be
   * absent, truncated to an origin, or influenced by referrer-policy). A
   * refactor that reordered the two checks, or treated a missing allowlist hit
   * as "keep looking", would silently accept every cross-site request that
   * bothered to set a plausible Referer, and no other test here would go red.
   */
  it("rejects a disallowed Origin EVEN WITH a valid allowed Referer", () => {
    const request = postRequest({
      Origin: "https://evil.com",
      Referer: "https://community.thinkersjournal.com/x",
    });
    expect(checkOrigin(DEV_ENV, request)).toBe(false);
  });

  it("falls back to a valid allowed Referer when Origin is absent", () => {
    const request = postRequest({
      Referer: "https://community.thinkersjournal.com/some/page?query=1",
    });
    expect(checkOrigin(DEV_ENV, request)).toBe(true);
  });

  it("rejects a malformed Referer without throwing", () => {
    const request = postRequest({ Referer: "not a url at all" });
    expect(() => checkOrigin(DEV_ENV, request)).not.toThrow();
    expect(checkOrigin(DEV_ENV, request)).toBe(false);
  });

  it("fails closed when both Origin and Referer are missing on a non-GET", () => {
    const request = postRequest({});
    expect(checkOrigin(DEV_ENV, request)).toBe(false);
  });

  it("always allows GET regardless of headers", () => {
    const request = new Request("https://api.test/some-endpoint", {
      method: "GET",
      headers: { Origin: "https://evil.com" },
    });
    expect(checkOrigin(DEV_ENV, request)).toBe(true);
  });

  it("always allows HEAD regardless of headers", () => {
    const request = new Request("https://api.test/some-endpoint", {
      method: "HEAD",
    });
    expect(checkOrigin(DEV_ENV, request)).toBe(true);
  });

  /**
   * The two LOCAL DEV origins in the allowlist, pinned by exact string.
   *
   * These are load-bearing for local dev and for the E2E suite, which drives a
   * real browser against `http://localhost:8787` — every mutating request it
   * makes carries one of these as its `Origin` and 403s at the pipeline's first
   * step without them. Nothing else in the unit suite asserts them, so an
   * accidental edit (a typo, a "tidy-up" dropping the `127.0.0.1` spelling as
   * redundant, an over-eager prod-only hardening) would go unnoticed here and
   * surface only as a baffling E2E failure. Both spellings are required: a
   * browser sends whichever the developer typed, and they are DIFFERENT origins.
   */
  it.each(["http://localhost:8787", "http://127.0.0.1:8787"])(
    "allows the localhost dev origin %s",
    (origin) => {
      expect(checkOrigin(DEV_ENV, postRequest({ Origin: origin }))).toBe(true);
    },
  );
});

/**
 * THE `TEST_ROUTES` GATE ON THE DEV ORIGINS (src/auth/csrf.ts).
 *
 * BOTH modes are pinned, and the PRODUCTION one is the whole point of this
 * block: the suite runs with `TEST_ROUTES="1"`, so every other `checkOrigin`
 * case above exercises the DEV allowlist only. Without these cases the
 * production allowlist — the one that actually ships — would never be evaluated
 * at all, and a regression that widened it back to include localhost would go
 * completely unnoticed. (Exactly the argument test/session.test.ts makes for
 * pinning both cookie modes, and it is the same gate.)
 *
 * The gate is an explicit `=== "1"`, never truthiness: wrangler vars are always
 * strings, so `"0"` and `"false"` are TRUTHY and would otherwise widen the
 * production allowlist for anyone who set "0" to mean "off". Pinned below.
 */
describe("checkOrigin — the TEST_ROUTES gate on the dev origins", () => {
  it.each(["http://localhost:8787", "http://127.0.0.1:8787"])(
    "REJECTS the dev origin %s in production (TEST_ROUTES unset)",
    (origin) => {
      expect(checkOrigin(PROD_ENV, postRequest({ Origin: origin }))).toBe(false);
    },
  );

  it("still allows the production origin in production (TEST_ROUTES unset)", () => {
    expect(
      checkOrigin(
        PROD_ENV,
        postRequest({ Origin: "https://community.thinkersjournal.com" }),
      ),
    ).toBe(true);
  });

  it("rejects a dev-origin Referer fallback in production too (not just the Origin header)", () => {
    // The gate must apply to BOTH branches of `checkOrigin`. A fix that only
    // guarded the `Origin` path would leave `Referer: http://localhost:8787/x`
    // as a live bypass of exactly the thing being gated.
    const request = postRequest({ Referer: "http://localhost:8787/signup" });
    expect(checkOrigin(PROD_ENV, request)).toBe(false);
    // ...and the same request IS accepted in dev, so the case above is the gate
    // biting rather than the Referer fallback being broken outright.
    expect(checkOrigin(DEV_ENV, request)).toBe(true);
  });

  it.each(["0", "false", "", "true", "yes"])(
    "treats TEST_ROUTES=%j as OFF — only the literal \"1\" widens the allowlist",
    (value) => {
      const weirdEnv = { ...env, TEST_ROUTES: value } as unknown as Env;
      expect(
        checkOrigin(weirdEnv, postRequest({ Origin: "http://localhost:8787" })),
      ).toBe(false);
      // Production origins are unaffected by the gate in every mode.
      expect(
        checkOrigin(
          weirdEnv,
          postRequest({ Origin: "https://community.thinkersjournal.com" }),
        ),
      ).toBe(true);
    },
  );
});

/**
 * THE PRE-LAUNCH `PREVIEW_ORIGIN` MECHANISM (src/auth/csrf.ts).
 *
 * A temporary, deploy-time-only affordance: setting the optional `PREVIEW_ORIGIN`
 * var (`wrangler deploy --var PREVIEW_ORIGIN:https://<worker>.workers.dev`) adds
 * exactly that one origin to the allowlist, so mutations (signup/login) can be
 * exercised on the `*.workers.dev` hostname BEFORE DNS points the real domain at
 * the Worker. It is NOT in wrangler.jsonc's `vars`, so a normal production deploy
 * (no `--var`) never sees it and it collapses back to the base allowlist.
 *
 * The security-load-bearing pair here is (a) the preview origin is accepted ONLY
 * when the var names it, and (b) it is REJECTED the moment the var is absent or
 * empty — i.e. it is genuinely additive and cannot silently persist after the
 * `--var` is dropped at DNS launch. Both `Origin` and `Referer` branches must
 * honour it, and it must add to — never replace — the production origin.
 */
describe("checkOrigin — the pre-launch PREVIEW_ORIGIN affordance", () => {
  const PREVIEW = "https://thinkersjournal-web.ciresnave.workers.dev";
  // Production shape (TEST_ROUTES unset) PLUS the preview origin — this is
  // exactly the shipped preview deploy: prod allowlist, no dev origins, one
  // extra workers.dev host.
  const PREVIEW_ENV = {
    ...env,
    TEST_ROUTES: undefined,
    PREVIEW_ORIGIN: PREVIEW,
  } as unknown as Env;

  it("allows a POST from the preview origin when PREVIEW_ORIGIN names it", () => {
    expect(checkOrigin(PREVIEW_ENV, postRequest({ Origin: PREVIEW }))).toBe(true);
  });

  it("honours the preview origin via the Referer fallback too", () => {
    const request = postRequest({ Referer: `${PREVIEW}/signup` });
    expect(checkOrigin(PREVIEW_ENV, request)).toBe(true);
  });

  it("still allows the production origin when PREVIEW_ORIGIN is set (additive, not a replacement)", () => {
    expect(
      checkOrigin(
        PREVIEW_ENV,
        postRequest({ Origin: "https://community.thinkersjournal.com" }),
      ),
    ).toBe(true);
  });

  it("REJECTS the preview origin when PREVIEW_ORIGIN is unset (the var must be load-bearing)", () => {
    // PROD_ENV has no PREVIEW_ORIGIN at all — dropping the `--var` at DNS launch
    // must make this origin stop working, or the affordance could silently
    // outlive its purpose.
    expect(checkOrigin(PROD_ENV, postRequest({ Origin: PREVIEW }))).toBe(false);
  });

  it.each(["", undefined])(
    "treats PREVIEW_ORIGIN=%j as OFF — an empty/absent value adds nothing",
    (value) => {
      const emptyEnv = {
        ...env,
        TEST_ROUTES: undefined,
        PREVIEW_ORIGIN: value,
      } as unknown as Env;
      expect(checkOrigin(emptyEnv, postRequest({ Origin: PREVIEW }))).toBe(false);
      // ...and an empty PREVIEW_ORIGIN must not disturb the production origin.
      expect(
        checkOrigin(
          emptyEnv,
          postRequest({ Origin: "https://community.thinkersjournal.com" }),
        ),
      ).toBe(true);
    },
  );

  it("does not treat PREVIEW_ORIGIN as a substring/prefix match", () => {
    // The check is exact-set membership. A look-alike origin that merely starts
    // with the preview host must not slip through.
    const lookalike = "https://thinkersjournal-web.ciresnave.workers.dev.evil.com";
    expect(checkOrigin(PREVIEW_ENV, postRequest({ Origin: lookalike }))).toBe(false);
  });
});

/**
 * The allowlist is a property of the METHOD CLASS (anything not GET/HEAD), not
 * of POST. Only POST was exercised above; a `method === "POST"` check
 * substituted for the safe-method guard would pass every one of those cases
 * while leaving PUT/PATCH/DELETE — which the API will grow in M1 — completely
 * unguarded.
 */
describe("checkOrigin across unsafe methods", () => {
  it.each(UNSAFE_METHODS)("allows %s from an allowed Origin", (method) => {
    const request = requestWithMethod(method, {
      Origin: "https://community.thinkersjournal.com",
    });
    expect(checkOrigin(DEV_ENV, request)).toBe(true);
  });

  it.each(UNSAFE_METHODS)("rejects %s from a disallowed Origin", (method) => {
    const request = requestWithMethod(method, { Origin: "https://evil.com" });
    expect(checkOrigin(DEV_ENV, request)).toBe(false);
  });

  it.each(UNSAFE_METHODS)(
    "fails closed on %s with neither Origin nor Referer",
    (method) => {
      expect(checkOrigin(DEV_ENV, requestWithMethod(method, {}))).toBe(false);
    },
  );
});

describe("csrfTokenFor", () => {
  it("returns the hex-encoded SHA-256 digest of the session's csrfSecret", async () => {
    const token = await csrfTokenFor(sampleSession);
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    // Same secret -> same token, deterministically.
    expect(await csrfTokenFor(sampleSession)).toBe(token);

    // Independently computable via raw WebCrypto for the same secret.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(sampleSession.csrfSecret),
    );
    const expected = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(token).toBe(expected);
  });

  it("never exposes the raw csrfSecret in the token", async () => {
    const token = await csrfTokenFor(sampleSession);
    expect(token).not.toContain(sampleSession.csrfSecret);
  });
});

describe("checkCsrf", () => {
  it("accepts a POST carrying the correct X-CSRF-Token", async () => {
    const token = await csrfTokenFor(sampleSession);
    const request = postRequest({
      Origin: "https://community.thinkersjournal.com",
      "X-CSRF-Token": token,
    });
    expect(await checkCsrf(request, sampleSession)).toBe(true);
  });

  it("rejects a POST with a missing X-CSRF-Token", async () => {
    const request = postRequest({ Origin: "https://community.thinkersjournal.com" });
    expect(await checkCsrf(request, sampleSession)).toBe(false);
  });

  it("rejects a POST with an incorrect X-CSRF-Token", async () => {
    const request = postRequest({
      Origin: "https://community.thinkersjournal.com",
      "X-CSRF-Token": "0".repeat(64),
    });
    expect(await checkCsrf(request, sampleSession)).toBe(false);
  });

  it("rejects a token of the wrong length outright (no throw)", async () => {
    const request = postRequest({ "X-CSRF-Token": "too-short" });
    expect(await checkCsrf(request, sampleSession)).toBe(false);
  });

  it("always allows GET regardless of headers/token", async () => {
    const request = new Request("https://api.test/some-endpoint", {
      method: "GET",
    });
    expect(await checkCsrf(request, sampleSession)).toBe(true);
  });

  it("always allows HEAD regardless of headers/token", async () => {
    const request = new Request("https://api.test/some-endpoint", {
      method: "HEAD",
    });
    expect(await checkCsrf(request, sampleSession)).toBe(true);
  });
});
