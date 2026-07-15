import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src";
import {
  createVerificationToken,
  deleteVerificationToken,
  peekVerificationToken,
  sendVerificationEmail,
  TEST_LAST_TOKEN_KEY,
} from "../src/auth/email-verify";
import { createSession } from "../src/auth/session";
import { withClient } from "../src/db/client";

/**
 * Task 12 — email verification: one-time tokens, the Postmark send, the
 * `GET /verify-email` route, and the TEST-ONLY token-exposure route.
 *
 * Runs in the POOL project (real workerd) because it needs the `SESSIONS` KV,
 * `HYPERDRIVE_FRESH` and `USER_SECURITY` (DO) bindings, plus the Worker's
 * `fetch` handler.
 *
 * `cloudflare:test` does NOT export undici's `fetchMock` in the installed
 * `@cloudflare/vitest-pool-workers@0.18.4` (see test/turnstile.test.ts for the
 * verification), so the Postmark test stubs the global `fetch` with
 * `vi.stubGlobal` and restores it in `afterEach` — otherwise the stub leaks
 * into sibling pool test files sharing this workerd isolate.
 *
 * ⚠️ `GET /verify-email` REQUIRES AUTHENTICATION (see the header of
 * src/routes/verify-email.ts): holding the emailed link is not enough, the
 * caller must also hold a live, non-stale session for the token's OWN user.
 * That is what stops a victim's click on their own link from verifying an
 * account an attacker has taken over. The end-to-end takeover regression lives
 * in test/signup.test.ts (it needs a real re-signup); the cases here pin each
 * individual check.
 */

// `users.password_hash` is NOT NULL — a valid PHC-encoded argon2id string.
const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$ZGlnZXN0";

/** Rows created by a test, deleted in `afterEach`. */
const createdUserIds: string[] = [];

/** INSERT a user with a per-run-unique email; returns its generated id. */
async function insertUser(): Promise<string> {
  const ctx = createExecutionContext();
  const email = `t12_${crypto.randomUUID()}@example.com`;
  const id = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
      [email, PASSWORD_HASH],
    );
    return rows[0].id as string;
  });
  await waitOnExecutionContext(ctx);
  createdUserIds.push(id);
  return id;
}

/**
 * Mint a session for `userId` and return the `Cookie` header value carrying it.
 * `createSession` hands back a full `Set-Cookie` string; the request needs only
 * its leading `tj_session=<token>` pair.
 *
 * Defaults `securityEpoch` to the user's CURRENT epoch, i.e. a fresh, non-stale
 * session — pass an explicit value (or bump the DO afterwards) to make it stale.
 */
async function sessionCookieFor(
  userId: string,
  securityEpoch?: number,
): Promise<string> {
  const epoch =
    securityEpoch ?? (await env.USER_SECURITY.getByName(userId).getEpoch());
  const { cookie } = await createSession(env, {
    userId,
    roles: [],
    securityEpoch: epoch,
    csrfSecret: "test-csrf-secret",
    createdAt: Date.now(),
  });
  return cookie.split(";")[0]!;
}

/** `GET /verify-email?token=…` through the Worker's router, optionally signed in. */
async function verifyEmail(token: string, cookie?: string): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(
      `https://api.test/verify-email?token=${encodeURIComponent(token)}`,
      cookie === undefined ? undefined : { headers: { Cookie: cookie } },
    ),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

/** Read a user's `email_verified_at` through the FRESH (cache-disabled) binding. */
async function readVerifiedAt(userId: string): Promise<Date | null> {
  const ctx = createExecutionContext();
  const value = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query(
      "SELECT email_verified_at FROM users WHERE id = $1",
      [userId],
    );
    return (rows[0]?.email_verified_at ?? null) as Date | null;
  });
  await waitOnExecutionContext(ctx);
  return value;
}

beforeEach(async () => {
  // Verification tokens AND the `__test:` stash both live in SESSIONS; clear it
  // so each case is independent of the last.
  let cursor: string | undefined;
  do {
    const result = await env.SESSIONS.list(cursor ? { cursor } : undefined);
    await Promise.all(result.keys.map((k) => env.SESSIONS.delete(k.name)));
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor !== undefined);
});

afterEach(async () => {
  // Restore the global `fetch` so the Postmark stub never leaks into sibling
  // pool test files, and any `console.error` spy so expected error logs don't
  // pollute the run.
  vi.unstubAllGlobals();
  vi.restoreAllMocks();

  if (createdUserIds.length > 0) {
    const ctx = createExecutionContext();
    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
      c.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [createdUserIds]),
    );
    await waitOnExecutionContext(ctx);
    createdUserIds.length = 0;
  }
});

describe("verification tokens", () => {
  /**
   * The peek is NON-consuming BY DESIGN, and that is a security property, not an
   * implementation detail: `GET /verify-email` must resolve a token to its user
   * before it can authenticate the caller, and a caller who FAILS those checks
   * must not have burned the token — a legitimate user who clicks the link
   * before signing in has to be able to click it again afterwards.
   */
  it("peeks a token without consuming it (repeatable)", async () => {
    const userId = crypto.randomUUID();
    const token = await createVerificationToken(env, userId);

    expect(await peekVerificationToken(env, token)).toBe(userId);
    expect(await peekVerificationToken(env, token)).toBe(userId);
  });

  it("makes a token unusable once deleted (one-time on redemption)", async () => {
    const userId = crypto.randomUUID();
    const token = await createVerificationToken(env, userId);

    await deleteVerificationToken(env, token);

    expect(await peekVerificationToken(env, token)).toBeNull();
  });

  it("returns null for an unknown token", async () => {
    expect(await peekVerificationToken(env, "not-a-real-token")).toBeNull();
  });

  it("deletes an unknown token without throwing (idempotent)", async () => {
    await expect(
      deleteVerificationToken(env, "not-a-real-token"),
    ).resolves.toBeUndefined();
  });

  it("stores the token HASHED — KV never holds the raw token", async () => {
    const userId = crypto.randomUUID();
    const token = await createVerificationToken(env, userId);

    // The raw token must not be a KV key ...
    expect(await env.SESSIONS.get(`verify-email:${token}`)).toBeNull();

    // ... and the only `verify-email:` key present is the sha256 hex of it.
    const { keys } = await env.SESSIONS.list({ prefix: "verify-email:" });
    expect(keys).toHaveLength(1);
    expect(keys[0]!.name).toMatch(/^verify-email:[0-9a-f]{64}$/);
  });

  it("stores the token with a 24h TTL", async () => {
    const before = Math.floor(Date.now() / 1000);
    await createVerificationToken(env, crypto.randomUUID());

    const { keys } = await env.SESSIONS.list({ prefix: "verify-email:" });
    const expiration = keys[0]!.expiration;
    expect(expiration).toBeDefined();
    // 86_400s from now, allowing a couple of seconds of clock slop.
    expect(expiration!).toBeGreaterThanOrEqual(before + 86_400 - 5);
    expect(expiration!).toBeLessThanOrEqual(before + 86_400 + 5);
  });
});

describe("GET /verify-email", () => {
  it("consumes the token and sets email_verified_at", async () => {
    const userId = await insertUser();
    expect(await readVerifiedAt(userId)).toBeNull();

    const token = await createVerificationToken(env, userId);
    const response = await verifyEmail(token, await sessionCookieFor(userId));

    expect(response.status).toBe(200);
    // Read back through FRESH (cache-disabled) — a CACHED read-after-write here
    // would be a security bug.
    expect(await readVerifiedAt(userId)).not.toBeNull();
  });

  it("rejects an unknown token with a 400 (not a 500)", async () => {
    const cookie = await sessionCookieFor(await insertUser());

    expect((await verifyEmail("bogus", cookie)).status).toBe(400);
  });

  it("rejects a missing token with a 400 (not a 500)", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.test/verify-email"),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(400);
  });

  it("does not re-verify on a replayed token", async () => {
    const userId = await insertUser();
    const token = await createVerificationToken(env, userId);
    const cookie = await sessionCookieFor(userId);

    const first = await verifyEmail(token, cookie);
    const second = await verifyEmail(token, cookie);

    expect(first.status).toBe(200);
    // ONE-TIME ON SUCCESS: the first verify burned the token.
    expect(second.status).toBe(400);
  });

  /**
   * Verification REQUIRES a session — holding the emailed link is not enough.
   * See the header of src/routes/verify-email.ts for the takeover chain this
   * closes.
   *
   * The token must SURVIVE this rejection: the user hasn't done anything wrong,
   * they just clicked the link before signing in. Burning it here would strand
   * them with no way to verify (there is no resend endpoint until M1), which is
   * why the route peeks rather than consumes.
   */
  it("401s LOGIN_REQUIRED with no session, leaving the user unverified and the token UNBURNED", async () => {
    const userId = await insertUser();
    const token = await createVerificationToken(env, userId);

    const response = await verifyEmail(token);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "LOGIN_REQUIRED" });
    expect(await readVerifiedAt(userId)).toBeNull();

    // THE TOKEN IS STILL GOOD: sign in and click the SAME link again.
    const retry = await verifyEmail(token, await sessionCookieFor(userId));
    expect(retry.status).toBe(200);
    expect(await readVerifiedAt(userId)).not.toBeNull();
  });

  /**
   * A session for SOMEONE ELSE must not verify this token's user — otherwise any
   * account could verify any address whose link it got hold of.
   */
  it("rejects a session belonging to a DIFFERENT user than the token's", async () => {
    const tokenUserId = await insertUser();
    const otherUserId = await insertUser();
    const token = await createVerificationToken(env, tokenUserId);

    const response = await verifyEmail(
      token,
      await sessionCookieFor(otherUserId),
    );

    expect(response.status).toBe(403);
    // The SAME generic body as every other auth failure: a distinct "not your
    // token" would let an attacker probe whose token they hold.
    expect(await response.json()).toEqual({ code: "LOGIN_REQUIRED" });
    expect(await readVerifiedAt(tokenUserId)).toBeNull();
  });

  /**
   * ⚠️ THE LOAD-BEARING CHECK. A session issued BEFORE the user's last
   * `bumpEpoch()` proves knowledge of a password that is no longer current, so
   * it must not verify. Without this the whole auth gate is theatre: the
   * victim's pre-takeover session is a live session for the right user, so it
   * would satisfy every other check and the takeover in
   * src/routes/verify-email.ts's header would stand.
   */
  it("401s LOGIN_REQUIRED for a STALE session (epoch bumped after it was issued)", async () => {
    const userId = await insertUser();
    const token = await createVerificationToken(env, userId);
    const cookie = await sessionCookieFor(userId);

    // Everything the account holds is revoked — e.g. a re-signup took it over.
    await env.USER_SECURITY.getByName(userId).bumpEpoch();

    const response = await verifyEmail(token, cookie);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "LOGIN_REQUIRED" });
    expect(await readVerifiedAt(userId)).toBeNull();
  });
});

describe("sendVerificationEmail", () => {
  it("POSTs the Postmark request with the documented shape", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedInit = init;
        return new Response(JSON.stringify({ ErrorCode: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const url = "https://thinkersjournal.com/verify-email?token=abc123";
    await sendVerificationEmail(env, "reader@example.com", url);

    expect(capturedUrl).toBe("https://api.postmarkapp.com/email");
    expect(capturedInit?.method).toBe("POST");

    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("X-Postmark-Server-Token")).toBe(
      env.POSTMARK_SERVER_TOKEN,
    );
    expect(headers.get("content-type")).toBe("application/json");

    const body = JSON.parse(String(capturedInit?.body)) as Record<
      string,
      unknown
    >;
    // `From` MUST be the confirmed sender — a non-confirmed sender fails
    // silently in production.
    expect(body.From).toBe("noreply@thinkersjournal.com");
    expect(body.To).toBe("reader@example.com");
    expect(body.MessageStream).toBe("outbound");
    expect(body.Subject).toEqual(expect.any(String));
    expect(String(body.TextBody)).toContain(url);
    expect(String(body.HtmlBody)).toContain(url);
  });

  it("escapes the url before interpolating it into HtmlBody", async () => {
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedInit = init;
        return new Response(JSON.stringify({ ErrorCode: 0 }), { status: 200 });
      }),
    );

    // A later task builds this url from a request Host/Origin header, so treat
    // it as attacker-controlled: it must not be able to break out of the href
    // attribute and inject markup into mail from our confirmed sender.
    const hostile =
      'https://evil.test/verify-email?token=t"><script>alert(1)</script><a href="';
    await sendVerificationEmail(env, "reader@example.com", hostile);

    const body = JSON.parse(String(capturedInit?.body)) as Record<
      string,
      unknown
    >;
    const html = String(body.HtmlBody);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    // The href attribute is not broken out of: no raw `"` survives from the url.
    expect(html).toContain("&quot;");
    // TextBody is not HTML, so it carries the url verbatim.
    expect(String(body.TextBody)).toContain(hostile);
  });

  // A failed send must NEVER throw: it is a side effect of signup (Task 14), and
  // the account already exists by the time it runs. Throwing would 500 a signup
  // that actually succeeded.
  it("resolves (does not throw) on a non-2xx response, and logs the status", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized", { status: 401 })),
    );

    await expect(
      sendVerificationEmail(env, "reader@example.com", "https://x.test/v?t=1"),
    ).resolves.toBeUndefined();

    expect(errorLog).toHaveBeenCalledWith(
      "postmark send failed",
      expect.objectContaining({ status: 401 }),
    );
  });

  it("resolves and logs when Postmark returns 200 with a non-zero ErrorCode", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    // How the unconfirmed-sender misconfiguration actually surfaces: HTTP 200,
    // ErrorCode 400. Previously this was discarded and the send looked fine.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ErrorCode: 400,
              Message: "Sender signature not confirmed",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    await expect(
      sendVerificationEmail(env, "reader@example.com", "https://x.test/v?t=1"),
    ).resolves.toBeUndefined();

    expect(errorLog).toHaveBeenCalledWith(
      "postmark rejected send",
      expect.objectContaining({
        ErrorCode: 400,
        Message: "Sender signature not confirmed",
      }),
    );
  });

  it("resolves (does not throw) when the fetch itself rejects", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network failure");
      }),
    );

    await expect(
      sendVerificationEmail(env, "reader@example.com", "https://x.test/v?t=1"),
    ).resolves.toBeUndefined();

    expect(errorLog).toHaveBeenCalledWith(
      "postmark request threw",
      expect.any(TypeError),
    );
  });

  it("does not log the email or the url — the url embeds the raw token", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );

    const url = "https://x.test/verify-email?token=SUPER-SECRET-TOKEN";
    await sendVerificationEmail(env, "reader@example.com", url);

    // Logging the url would write an account-takeover credential to the logs.
    const logged = JSON.stringify(errorLog.mock.calls);
    expect(logged).not.toContain("SUPER-SECRET-TOKEN");
    expect(logged).not.toContain("reader@example.com");
  });

  it("resolves normally on a successful send without logging", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ErrorCode: 0, Message: "OK" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    await expect(
      sendVerificationEmail(env, "reader@example.com", "https://x.test/v?t=1"),
    ).resolves.toBeUndefined();

    expect(errorLog).not.toHaveBeenCalled();
  });
});

describe("GET /__test/last-verify-token", () => {
  it("returns the last raw token when TEST_ROUTES is set", async () => {
    const userId = crypto.randomUUID();
    const token = await createVerificationToken(env, userId);

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.test/__test/last-verify-token"),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(token);
  });

  it("stashes the raw token under the fixed TEST key", async () => {
    const token = await createVerificationToken(env, crypto.randomUUID());
    expect(await env.SESSIONS.get(TEST_LAST_TOKEN_KEY)).toBe(token);
  });

  // THE GATE. This route hands out a token that verifies an arbitrary account;
  // reaching production it would be a full account-takeover vector. With
  // TEST_ROUTES unset it must be indistinguishable from a nonexistent route.
  it("404s when TEST_ROUTES is unset — same as a nonexistent route", async () => {
    await createVerificationToken(env, crypto.randomUUID());

    // The pool sets TEST_ROUTES via `miniflare.bindings`; simulate production
    // (where the var is simply absent) by overriding it to undefined. The cast
    // is required because `wrangler types` types every var as a plain `string`.
    const prodEnv = { ...env, TEST_ROUTES: undefined } as unknown as Env;

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.test/__test/last-verify-token"),
      prodEnv,
      ctx,
    );
    const nonexistent = await worker.fetch(
      new Request("https://api.test/does-not-exist"),
      prodEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(404);
    // Byte-for-byte identical to a genuine 404: the gate leaks nothing, not
    // even the route's existence.
    expect(await response.text()).toBe(await nonexistent.text());
  });

  it("does not stash the raw token when TEST_ROUTES is unset", async () => {
    const prodEnv = { ...env, TEST_ROUTES: undefined } as unknown as Env;

    await createVerificationToken(prodEnv, crypto.randomUUID());

    expect(await env.SESSIONS.get(TEST_LAST_TOKEN_KEY)).toBeNull();
  });

  // Wrangler vars are ALWAYS strings, so "0"/"false" are truthy. A truthiness
  // gate would read `TEST_ROUTES="0"` — someone's idea of "off" — as ON and
  // start serving tokens. Only the literal "1" may enable these routes.
  it.each(["0", "false", "", "no", "true"])(
    "404s when TEST_ROUTES is %j — only the literal \"1\" enables the route",
    async (value) => {
      await createVerificationToken(env, crypto.randomUUID());
      const otherEnv = { ...env, TEST_ROUTES: value };

      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request("https://api.test/__test/last-verify-token"),
        otherEnv,
        ctx,
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(404);
    },
  );

  it.each(["0", "false"])(
    "does not stash the raw token when TEST_ROUTES is %j",
    async (value) => {
      const otherEnv = { ...env, TEST_ROUTES: value };

      await createVerificationToken(otherEnv, crypto.randomUUID());

      expect(await env.SESSIONS.get(TEST_LAST_TOKEN_KEY)).toBeNull();
    },
  );
});
