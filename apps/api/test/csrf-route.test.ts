import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import worker from "../src";
import { csrfTokenFor } from "../src/auth/csrf";
import { createSession, readSession } from "../src/auth/session";

import type { SessionData } from "@thinkersjournal/shared";

/**
 * Task 18 — `GET /auth/csrf`, the DELIVERY mechanism for the CSRF token that
 * `POST /posts` (and every other mutating route) requires in `X-CSRF-Token`.
 *
 * The token is `sha256Hex(session.csrfSecret)` — the web Worker can never
 * compute it, because `csrfSecret` lives only in this Worker's KV session
 * record and never leaves it. So the web app fetches it from here over the
 * Service Binding, forwarding the browser's session cookie, and embeds the
 * result in the rendered HTML (a hidden input) — NEVER a readable cookie.
 *
 * ⚠️ This is a GET, so it deliberately does NOT run the mutating pipeline
 * (src/auth/pipeline.ts): that pipeline's own CSRF step would require the very
 * token this route exists to hand out. Authentication is `readSession` alone.
 *
 * That it is a GET is safe: the session cookie is `SameSite=Lax`, so a
 * cross-site XHR/fetch cannot carry it (the read returns 401), and a top-level
 * cross-site NAVIGATION does carry it but lands the JSON in a document the
 * attacker's JS cannot read (same-origin policy, and no CORS headers are sent).
 *
 * Runs in the POOL project (real workerd): real `SESSIONS` KV, real WebCrypto.
 */

/**
 * Mint a real session and return its raw `tj_session` cookie token + data.
 *
 * The epoch is read from the user's DO rather than hardcoded, exactly as
 * `POST /auth/login` does — that is what lets the revocation cases below start
 * from a genuinely VALID session and make `bumpEpoch()` the only difference.
 */
async function authenticate(
  userId: string = crypto.randomUUID(),
): Promise<{ token: string; data: SessionData }> {
  const data: SessionData = {
    userId,
    roles: ["member"],
    securityEpoch: await env.USER_SECURITY.getByName(userId).getEpoch(),
    csrfSecret: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  const { cookie } = await createSession(env, data);
  const match = /^tj_session=([^;]*)/.exec(cookie);
  if (match === null) {
    throw new Error(`cookie did not match expected shape: ${cookie}`);
  }
  return { token: match[1]!, data };
}

/** Drive the Worker through a full request lifecycle. */
async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** `GET /auth/csrf`, optionally carrying `token`'s session cookie. */
function csrfRequest(token: string | null = null): Request {
  const headers = new Headers();
  if (token !== null) {
    headers.set("Cookie", `tj_session=${token}`);
  }
  return new Request("https://api.test/auth/csrf", { headers });
}

beforeEach(async () => {
  // Isolate SESSIONS across tests within this pool file (isolatedStorage was
  // removed, so KV contents persist across tests otherwise).
  const { keys } = await env.SESSIONS.list();
  await Promise.all(keys.map((k) => env.SESSIONS.delete(k.name)));
});

describe("GET /auth/csrf", () => {
  it("200s with the authenticated session's CSRF token", async () => {
    const { token, data } = await authenticate();

    const response = await fetchWorker(csrfRequest(token));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = (await response.json()) as { csrfToken: string };
    // The exact value the client must echo back in `X-CSRF-Token`.
    expect(body.csrfToken).toBe(await csrfTokenFor(data));
    expect(body.csrfToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never leaks the raw csrfSecret — only its hash", async () => {
    const { token, data } = await authenticate();

    const response = await fetchWorker(csrfRequest(token));
    const text = await response.text();

    expect(text).not.toContain(data.csrfSecret);
  });

  it("401s with no session cookie at all", async () => {
    const response = await fetchWorker(csrfRequest());
    expect(response.status).toBe(401);
  });

  it("401s with an unknown/expired session token", async () => {
    const response = await fetchWorker(csrfRequest("not-a-real-session-token"));
    expect(response.status).toBe(401);
  });

  it("issues DIFFERENT tokens for different sessions", async () => {
    const a = await authenticate();
    const b = await authenticate();

    const aBody = (await (await fetchWorker(csrfRequest(a.token))).json()) as {
      csrfToken: string;
    };
    const bBody = (await (await fetchWorker(csrfRequest(b.token))).json()) as {
      csrfToken: string;
    };

    expect(aBody.csrfToken).not.toBe(bBody.csrfToken);
  });
});

/**
 * ⚠️ REVOCATION ON A GET — `readSession` ALONE IS NOT ENOUGH HERE.
 *
 * A session's KV record OUTLIVES its revocation: bumping a user's epoch (a
 * re-signup taking the account over, or `POST /auth/logout-all` from another
 * device) invalidates every outstanding session WITHOUT enumerating them, which
 * is exactly what makes revocation O(1). So a revoked session still resolves
 * through `readSession` perfectly well.
 *
 * Before the epoch check, that meant this route answered a revoked session with
 * 200 + a valid token while a GARBAGE cookie got a 401 — reintroducing, on this
 * one route, precisely the oracle src/auth/pipeline.ts deliberately suppresses
 * (it makes "no session" and "revoked session" byte-identical, so a caller
 * holding a stolen-but-dead cookie learns nothing).
 *
 * The token was never the exploit: it is inert, because any mutation carrying it
 * dies at the pipeline's own epoch step. The defects were the STATUS difference
 * and leaving the dead cookie in the browser to be replayed forever.
 *
 * Deleting the epoch check from src/routes/csrf.ts must turn these RED.
 */
describe("GET /auth/csrf — revoked sessions", () => {
  it("answers a REVOKED session exactly as it answers no session at all (no oracle)", async () => {
    const userId = crypto.randomUUID();
    const { token } = await authenticate(userId);

    // Baseline: the very same cookie WORKS before the bump, so the 401 below is
    // attributable to the revocation and nothing else.
    expect((await fetchWorker(csrfRequest(token))).status).toBe(200);

    await env.USER_SECURITY.getByName(userId).bumpEpoch();

    const revoked = await fetchWorker(csrfRequest(token));
    const noSession = await fetchWorker(csrfRequest());

    expect(revoked.status).toBe(401);
    expect(revoked.status).toBe(noSession.status);

    // Compared as RAW TEXT, not parsed-then-deep-equal, so the check is
    // genuinely byte-identical rather than merely "same keys/values".
    const [revokedText, noSessionText] = await Promise.all([
      revoked.text(),
      noSession.text(),
    ]);
    expect(revokedText).toBe(noSessionText);
    expect(revokedText).toBe(JSON.stringify({ code: "LOGIN_REQUIRED" }));
  });

  it("never hands a revoked session a CSRF token", async () => {
    const userId = crypto.randomUUID();
    const { token, data } = await authenticate(userId);

    await env.USER_SECURITY.getByName(userId).bumpEpoch();

    const response = await fetchWorker(csrfRequest(token));
    const text = await response.text();

    expect(text).not.toContain(await csrfTokenFor(data));
    expect(text).not.toContain(data.csrfSecret);
  });

  it("clears the cookie and destroys the KV record on the revoked path", async () => {
    const userId = crypto.randomUUID();
    const { token } = await authenticate(userId);

    await env.USER_SECURITY.getByName(userId).bumpEpoch();
    const response = await fetchWorker(csrfRequest(token));

    // The cookie must be actively CLEARED, not merely rejected — otherwise the
    // browser keeps replaying a session that can never succeed again. This is
    // the ONE respect in which the revoked and no-session responses differ, and
    // it is the same accepted asymmetry src/auth/pipeline.ts makes: a Set-Cookie
    // is observable, but the alternative (a dead cookie replayed forever) is
    // worse for the legitimate user and tells an attacker who already holds the
    // cookie nothing they did not know.
    const setCookie = response.headers.get("Set-Cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain("tj_session=");

    // And `destroySession` really ran: the record is gone from KV, so the token
    // is dead server-side even if a client ignores the cookie.
    const probe = new Request("https://api.test/", {
      headers: { Cookie: `tj_session=${token}` },
    });
    expect(await readSession(env, probe)).toBeNull();
  });

  it("matches GET /verify-email's treatment of the same revoked session", async () => {
    // The two session-bearing GETs must agree: both reject a revoked session
    // with 401 LOGIN_REQUIRED. An inconsistency between them is how the seam
    // this fix closes appeared in the first place.
    const userId = crypto.randomUUID();
    const { token } = await authenticate(userId);
    await env.USER_SECURITY.getByName(userId).bumpEpoch();

    const csrf = await fetchWorker(csrfRequest(token));
    const verify = await fetchWorker(
      new Request("https://api.test/verify-email?token=some-token", {
        headers: { Cookie: `tj_session=${token}` },
      }),
    );

    expect(csrf.status).toBe(401);
    expect(await csrf.json()).toEqual({ code: "LOGIN_REQUIRED" });
    // verify-email checks the token's existence before the epoch, so an unknown
    // token 400s first — assert only that neither route SUCCEEDS for a revoked
    // session, which is the property they must share.
    expect(verify.status).not.toBe(200);
  });
});
