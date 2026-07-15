import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Statically-imported, precompiled `WebAssembly.Module`s — same files
// src/auth/password.ts uses, so this test-only helper (see `hashWithParams`
// below) shares the exact bundling story as the app code it is exercising.
import setupWasm from "argon2id/lib/setup.js";
import nonSimdWasm from "argon2id/dist/no-simd.wasm";
import simdWasm from "argon2id/dist/simd.wasm";

import type { SessionData } from "@thinkersjournal/shared";
import type { computeHash } from "argon2id/lib/setup.js";

import worker from "../src";
import { hashPassword, needsRehash } from "../src/auth/password";
import { readSession } from "../src/auth/session";
import { withClient } from "../src/db/client";
import { DUMMY_HASH } from "../src/routes/login";

/**
 * Task 15 — `POST /auth/login`. Runs in the POOL project (real workerd): needs
 * `SESSIONS` KV, `HYPERDRIVE_FRESH`, `USER_SECURITY` (DO) and `LOGIN_LIMITER`.
 *
 * ⚠️ Emails are UNIQUE PER RUN (`crypto.randomUUID()`) — the test DB persists
 * across runs, and a fixed address would collide with a previous run's row.
 * Uniqueness also gives natural rate-limit isolation: the route consumes TWO
 * `LOGIN_LIMITER` buckets (real limiter here, 10/60s each), `<ip>:<email>` and
 * `email:<email>`, and BOTH are keyed on the email — so a unique address means
 * a private pair of buckets per test. Most tests set no `CF-Connecting-IP`, so
 * their first key collapses to `unknown:<email>`; the multi-IP case below sets
 * it deliberately, which is the entire point of that test.
 */

const ORIGIN = "https://thinkersjournal.com";
const VALID_PASSWORD = "correct-horse-battery-staple";

/** Emails created by a test, deleted in `afterEach`. */
const createdEmails: string[] = [];

/** A per-run-unique address, registered for cleanup. */
function uniqueEmail(): string {
  const email = `t15_${crypto.randomUUID()}@example.com`;
  createdEmails.push(email);
  return email;
}

/** Run a query through the FRESH (cache-disabled) binding. */
async function query(
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const ctx = createExecutionContext();
  const rows = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const result = await c.query(sql, params);
    return result.rows as Record<string, unknown>[];
  });
  await waitOnExecutionContext(ctx);
  return rows;
}

/** Insert a `users` row directly (login has no signup step to go through). */
async function insertUser(email: string, passwordHash: string): Promise<string> {
  const rows = await query(
    "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
    [email, passwordHash],
  );
  return String(rows[0]!.id);
}

// ---- Weak-param hash generation (rehash-on-upgrade seeding) -----------------
//
// `src/auth/password.ts` deliberately exposes NO "hash with custom params"
// API (YAGNI for the app itself — it only ever hashes at `CURRENT_ARGON2_PARAMS`).
// To seed a row that `verifyPassword` genuinely ACCEPTS but `needsRehash` flags
// as weak, this test drives the same `argon2id` WASM module directly, mirroring
// password.ts's own setup but with caller-supplied (weaker) parameters.

function moduleLoader(
  mod: WebAssembly.Module,
): (imports: WebAssembly.Imports) => Promise<WebAssembly.WebAssemblyInstantiatedSource> {
  return async (imports) => {
    const instance = await WebAssembly.instantiate(mod, imports);
    return { module: mod, instance };
  };
}

let argon2Promise: Promise<computeHash> | undefined;
function getArgon2(): Promise<computeHash> {
  if (argon2Promise === undefined) {
    argon2Promise = setupWasm(moduleLoader(simdWasm), moduleLoader(nonSimdWasm));
  }
  return argon2Promise;
}

function b64encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/=+$/, "");
}

/** Params weaker than `CURRENT_ARGON2_PARAMS` (m=19456,t=2,p=1) — real OWASP baseline from a few years back. */
const WEAK_PARAMS = { memorySize: 4096, iterations: 1, parallelism: 1 };

/**
 * A REAL, verifiable PHC-encoded argon2id hash of `pw` at `params` — unlike a
 * hand-typed fixture, `verifyPassword(pw, hash)` genuinely returns `true` for
 * this, so it exercises the login route's actual rehash decision rather than
 * merely `needsRehash`'s string parsing.
 */
async function hashWithParams(
  pw: string,
  params: { memorySize: number; iterations: number; parallelism: number },
): Promise<string> {
  const argon2 = await getArgon2();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = argon2({
    password: new TextEncoder().encode(pw),
    salt,
    parallelism: params.parallelism,
    passes: params.iterations,
    memorySize: params.memorySize,
    tagLength: 32,
  });
  return `$argon2id$v=19$m=${params.memorySize},t=${params.iterations},p=${params.parallelism}$${b64encode(
    salt,
  )}$${b64encode(digest)}`;
}

function loginRequest(
  body: unknown,
  headers: Record<string, string> = { Origin: ORIGIN },
): Request {
  return new Request("https://api.test/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** POST /auth/login through the Worker's router. */
async function login(
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(loginRequest(body, headers), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function validBody(email: string, password: string = VALID_PASSWORD) {
  return { email, password };
}

/** The `Cookie` name=value pair a login response's `Set-Cookie` just set. */
function cookieFrom(response: Response): string {
  return response.headers.get("Set-Cookie")!.split(";")[0]!;
}

/** Read the `SessionData` a login response's cookie points at, via KV. */
async function sessionFromResponse(response: Response): Promise<SessionData | null> {
  const request = new Request("https://api.test/", {
    headers: { Cookie: cookieFrom(response) },
  });
  return readSession(env, request);
}

beforeEach(async () => {
  // Sessions live in SESSIONS; clear it so each case observes only its own
  // writes (the pool's `isolatedStorage` was removed — KV persists across
  // tests within this file otherwise).
  let cursor: string | undefined;
  do {
    const result = await env.SESSIONS.list(cursor ? { cursor } : undefined);
    await Promise.all(result.keys.map((k) => env.SESSIONS.delete(k.name)));
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor !== undefined);
});

afterEach(async () => {
  if (createdEmails.length > 0) {
    await query("DELETE FROM users WHERE email = ANY($1::citext[])", [
      createdEmails,
    ]);
    createdEmails.length = 0;
  }
});

describe("POST /auth/login", () => {
  it(
    "200s with correct credentials, sets a session cookie whose securityEpoch matches the DO",
    async () => {
      const email = uniqueEmail();
      const passwordHash = await hashPassword(VALID_PASSWORD);
      const userId = await insertUser(email, passwordHash);

      // ⚠️ BUMP FIRST — a fresh user's epoch is 0, so asserting the session's
      // epoch against a never-bumped DO would pass just as happily for a
      // hardcoded `securityEpoch: 0` that never consulted the DO at all.
      // Bumping to a NON-DEFAULT value is what actually pins "the route reads
      // this from the DO" (same precedent as test/signup.test.ts).
      await env.USER_SECURITY.getByName(userId).bumpEpoch();

      const response = await login(validBody(email));

      expect(response.status).toBe(200);
      expect(response.headers.get("Set-Cookie")).toContain("tj_session=");

      const session = await sessionFromResponse(response);
      expect(session).not.toBeNull();
      expect(session?.userId).toBe(userId);
      expect(session?.roles).toEqual([]);

      // Both the concrete post-bump value and agreement with the DO.
      expect(session?.securityEpoch).toBe(1);
      const epoch = await env.USER_SECURITY.getByName(userId).getEpoch();
      expect(session?.securityEpoch).toBe(epoch);
    },
    30_000,
  );

  it(
    "401s a wrong password and a nonexistent email with a BYTE-IDENTICAL body (no enumeration)",
    async () => {
      const email = uniqueEmail();
      const passwordHash = await hashPassword(VALID_PASSWORD);
      await insertUser(email, passwordHash);

      const wrongPassword = await login(validBody(email, "totally-wrong-password"));
      const nonexistentEmail = await login(validBody(uniqueEmail()));

      expect(wrongPassword.status).toBe(401);
      expect(nonexistentEmail.status).toBe(401);

      // The anti-enumeration assertion: the two failure modes must be
      // indistinguishable from the response body alone. Compared as RAW TEXT
      // (not parsed-then-deep-equal) so the check is genuinely byte-identical,
      // not merely "same keys/values" — a spec-only assertion would sail
      // through a happens-to-look-similar-but-differently-encoded response.
      const [wrongText, nonexistentText] = await Promise.all([
        wrongPassword.text(),
        nonexistentEmail.text(),
      ]);
      expect(wrongText).toBe(nonexistentText);

      // ...and from the HEADERS too, not just the body: a differing
      // `content-type` (or any other header) would be an oracle on its own.
      // Pinned explicitly so the property survives the shared `unauthorized()`
      // helper ever being split into two call-site-specific responses.
      expect([...wrongPassword.headers]).toEqual([...nonexistentEmail.headers]);

      // Neither failure issued a session.
      expect(wrongPassword.headers.get("Set-Cookie")).toBeNull();
      expect(nonexistentEmail.headers.get("Set-Cookie")).toBeNull();
    },
    30_000,
  );

  /**
   * A user hashed with weaker-than-current Argon2id params (a real OWASP
   * baseline from a few years back) logs in successfully AND the stored hash
   * silently upgrades to `CURRENT_ARGON2_PARAMS` — without a bulk migration.
   * A second login at the now-current params must NOT rehash again.
   */
  it(
    "rehashes a weak-params hash on successful login, and does not rehash again once current",
    async () => {
      const email = uniqueEmail();
      const weakHash = await hashWithParams(VALID_PASSWORD, WEAK_PARAMS);
      await insertUser(email, weakHash);

      const response = await login(validBody(email));
      expect(response.status).toBe(200);

      const afterFirst = await query(
        "SELECT password_hash FROM users WHERE email = $1",
        [email],
      );
      const upgradedHash = String(afterFirst[0]!.password_hash);
      expect(upgradedHash).not.toBe(weakHash);
      expect(upgradedHash).toContain("m=19456,t=2,p=1");

      // Second login at CURRENT params: the hash must stay exactly as-is.
      const secondResponse = await login(validBody(email));
      expect(secondResponse.status).toBe(200);

      const afterSecond = await query(
        "SELECT password_hash FROM users WHERE email = $1",
        [email],
      );
      expect(String(afterSecond[0]!.password_hash)).toBe(upgradedHash);
    },
    60_000,
  );

  it(
    "429s once over the rate limit (10/60s per ip+email)",
    async () => {
      // A nonexistent email: each allowed attempt still costs a real (dummy)
      // Argon2id verify (the timing-equalization path) and returns 401 — which
      // also proves the limiter runs BEFORE the DB lookup, since an address
      // that was never inserted still consumes quota rather than short-circuiting.
      const email = uniqueEmail();
      const body = validBody(email);

      for (let i = 0; i < 10; i++) {
        expect((await login(body)).status).toBe(401);
      }

      expect((await login(body)).status).toBe(429);
    },
    60_000,
  );

  it("403s a request from a non-allowlisted origin", async () => {
    const email = uniqueEmail();

    const response = await login(validBody(email), { Origin: "https://evil.test" });

    expect(response.status).toBe(403);
  });

  it("400s a malformed JSON body (not a 500)", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.test/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", Origin: ORIGIN },
        body: "{not json",
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(400);
  });

  it("400s input that fails LoginInput validation (e.g. an invalid email)", async () => {
    const response = await login({ email: "not-an-email", password: "x" });

    expect(response.status).toBe(400);
  });

  /**
   * The timing-equalization control (src/routes/login.ts) is otherwise
   * UNTESTABLE without measuring wall-clock time, which would flake. This
   * deterministic assertion pins the invariant that actually matters instead.
   *
   * `needsRehash` returns `true` for an unparseable hash AND for one whose
   * params have drifted from `CURRENT_ARGON2_PARAMS`, so `=== false` here
   * simultaneously proves `DUMMY_HASH` is (a) well-formed — a malformed string
   * would make `verifyPassword` bail in ~0ms via `parsePhc`, silently deleting
   * the control — and (b) still costed at the CURRENT params, so the no-row
   * path burns the same Argon2id work as a real wrong-password verify.
   *
   * ⚠️ If this reddens, DO NOT relax it: regenerate `DUMMY_HASH` at the new
   * `CURRENT_ARGON2_PARAMS` (see its comment in src/routes/login.ts).
   */
  it("keeps DUMMY_HASH well-formed and at CURRENT_ARGON2_PARAMS (timing-control guard)", () => {
    expect(needsRehash(DUMMY_HASH)).toBe(false);
  });

  /**
   * ⚠️ BRUTE-FORCE BYPASS REGRESSION. `users.email` is citext, so the login
   * lookup is case-INsensitive — but the limiter key is built from the parsed
   * email. If that email were NOT normalized to lowercase (see NormalizedEmail
   * in packages/shared/src/schemas.ts), `victim@…` and `Victim@…` would hit the
   * same user row through DIFFERENT limiter buckets, handing an attacker 10
   * fresh attempts per case variant (~2^16 for a typical address) from a single
   * IP and nullifying LOGIN_LIMITER entirely.
   *
   * Removing `.toLowerCase()` from the schema must turn this test RED.
   */
  it(
    "counts case-variant emails against the SAME rate-limit bucket (no case-rotation bypass)",
    async () => {
      const email = uniqueEmail();
      // Same address, case-rotated: citext resolves both to one row.
      const rotated = email.toUpperCase();
      expect(rotated).not.toBe(email);

      // Exhaust the 10/60s quota using the LOWERCASE spelling. These are
      // nonexistent-user 401s, which is all the limiter needs to count.
      for (let i = 0; i < 10; i++) {
        expect((await login(validBody(email))).status).toBe(401);
      }
      expect((await login(validBody(email))).status).toBe(429);

      // The UPPERCASE spelling must already be exhausted — it shares the bucket.
      // Without normalization this would be a 401 (a fresh bucket) instead.
      expect((await login(validBody(rotated))).status).toBe(429);
    },
    60_000,
  );

  /**
   * ⚠️ THE CREDENTIAL-STUFFING CEILING — the reason `POST /auth/login` consumes
   * TWO limiter buckets (`ip:email` AND `email`), not one.
   *
   * The `ip:email` key alone gives every IP its OWN bucket, so it bounds nothing
   * about a single ADDRESS: N IPs against one victim = N × 10 password guesses
   * per window, which a botnet (or anything with a proxy pool) supplies for
   * free. This route has NO Turnstile, so the limiter is its entire brute-force
   * defense — an unbounded multiplier on it is the whole ballgame.
   *
   * Here every request carries a DIFFERENT `CF-Connecting-IP`, so the `ip:email`
   * bucket is FRESH each time and can never be what returns the 429. Only the
   * email-only bucket can. Before that bucket existed this test's final request
   * was a 401 — an attacker just kept going.
   *
   * Removing the `email:${email}` `enforceRateLimit` call from
   * src/routes/login.ts must turn this test RED (mutation-verified).
   */
  it(
    "429s a single email attacked from MANY DIFFERENT IPs (the ip:email bucket alone would not)",
    async () => {
      const email = uniqueEmail();
      const body = validBody(email);

      // 10 attempts, each from a different IP => 10 distinct `ip:email` buckets,
      // every one of them holding 9 unused slots. These are nonexistent-user
      // 401s, which is all the limiter needs to count.
      for (let i = 0; i < 10; i++) {
        const response = await login(body, {
          Origin: ORIGIN,
          "CF-Connecting-IP": `203.0.113.${i}`,
        });
        expect(
          response.status,
          `attempt ${i + 1} from a fresh IP should still be allowed through to a 401`,
        ).toBe(401);
      }

      // The 11th, from yet another brand-new IP. Its `ip:email` bucket is
      // untouched, so a 429 here can ONLY come from the email-only bucket.
      const blocked = await login(body, {
        Origin: ORIGIN,
        "CF-Connecting-IP": "203.0.113.99",
      });
      expect(
        blocked.status,
        "an address must have a ceiling regardless of source IP — the email-only limiter bucket is missing",
      ).toBe(429);
    },
    60_000,
  );

  /**
   * ⚠️ ORDER: origin check BEFORE the limiter (src/routes/login.ts's header).
   *
   * The inverse order let a cross-site page burn a victim's login quota: it
   * cannot read the reply, but the request is still SENT, and if quota is spent
   * before the 403 then ~10 of them lock the victim out for up to 60s. This
   * pins that a rejected origin costs NO quota — the same address, from the same
   * (absent) IP, must still have its full allowance afterwards.
   */
  it(
    "spends NO rate-limit quota on a request rejected by the origin check",
    async () => {
      const email = uniqueEmail();
      const body = validBody(email);

      // 15 cross-site attempts — comfortably past LOGIN_LIMITER's 10/60s. If the
      // limiter ran first these would exhaust both of this email's buckets.
      for (let i = 0; i < 15; i++) {
        expect((await login(body, { Origin: "https://evil.test" })).status).toBe(403);
      }

      // The victim's own next attempt must still be evaluated on its merits
      // (a 401 for a nonexistent user), not turned away with a 429.
      expect(
        (await login(body)).status,
        "a cross-site POST burned the victim's login quota — checkOrigin must run before the limiter",
      ).toBe(401);
    },
    60_000,
  );

  /** Normalization must not break the citext lookup it exists to agree with. */
  it(
    "logs in successfully with a mixed-case spelling of a lowercase-stored email",
    async () => {
      const email = uniqueEmail();
      const passwordHash = await hashPassword(VALID_PASSWORD);
      const userId = await insertUser(email, passwordHash);

      const response = await login(validBody(email.toUpperCase()));

      expect(response.status).toBe(200);
      const session = await sessionFromResponse(response);
      expect(session?.userId).toBe(userId);
    },
    30_000,
  );
});
