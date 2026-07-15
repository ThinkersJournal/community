import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import worker from "../src";
import { csrfTokenFor } from "../src/auth/csrf";
import { createSession } from "../src/auth/session";

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

/** Mint a real session and return its raw `tj_session` cookie token + data. */
async function authenticate(): Promise<{ token: string; data: SessionData }> {
  const data: SessionData = {
    userId: crypto.randomUUID(),
    roles: ["member"],
    securityEpoch: 0,
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
