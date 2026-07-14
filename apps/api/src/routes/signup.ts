/**
 * `POST /auth/signup` — the route that composes every auth primitive built so
 * far. The ORDER of its steps is load-bearing and must not be rearranged:
 *
 *   1. zod validation      — reject garbage before spending any quota.
 *   2. rate limit          — bounds every step below (incl. the Turnstile call
 *                            and the Argon2id hash, which is deliberately
 *                            expensive and therefore a DoS lever if unbounded).
 *   3. Turnstile           — bot defense.
 *   4. origin check        — CSRF, BEFORE any DB touch.
 *   5. dup check (FRESH)   — verified dup -> 409; unverified dup -> re-signup.
 *   6. single transaction  — create (or take over) the user + profile.
 *   7. verification email  — never fails the signup (see step note below).
 *   8. security epoch      — stamped into the session.
 *   9. session             — opaque KV token.
 *  10. 201 + Set-Cookie.
 *
 * Only `checkOrigin` applies here, not the double-submit `checkCsrf`: there is
 * no session yet at signup time, so there is no `csrfSecret` to echo back.
 *
 * ⚠️ Every DB access goes through `HYPERDRIVE_FRESH` (cache-disabled). This is
 * auth + dup-email + read-after-write: Hyperdrive never invalidates on write,
 * so a `HYPERDRIVE_CACHED` read here would be a real security bug.
 */
import { SignupInput } from "@thinkersjournal/shared";

import { checkOrigin } from "../auth/csrf";
import {
  createVerificationToken,
  sendVerificationEmail,
} from "../auth/email-verify";
import { hashPassword } from "../auth/password";
import { enforceRateLimit } from "../auth/ratelimit";
import { createSession } from "../auth/session";
import { verifyTurnstile } from "../auth/turnstile";
import { withClient } from "../db/client";

import type { Client } from "pg";

/** Postgres SQLSTATE for `unique_violation`. */
const UNIQUE_VIOLATION = "23505";

/** Longest sanitized email local-part kept as a generated username's base. */
const USERNAME_BASE_MAX = 20;

/** Attempts to place a generated username before giving up (see `insertProfile`). */
const USERNAME_ATTEMPTS = 3;

/**
 * The canonical origin verification links point at when the request carries no
 * `Origin` header.
 *
 * ⚠️ NOT `new URL(request.url).origin`: that is derived from the client-supplied
 * `Host` header, which would let an attacker point the verification link in mail
 * sent from OUR confirmed sender at a host they control — a phishing/token-theft
 * vector (see the escaping note in src/auth/email-verify.ts).
 */
const CANONICAL_ORIGIN = "https://thinkersjournal.com";

/** Base64url-encode (URL-safe, no padding) raw bytes — RFC 4648 §5. */
function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function json(body: unknown, status: number, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * The 403 returned for BOTH a failed Turnstile challenge and a rejected origin.
 * One shared response keeps the two defenses from being probed apart.
 */
function forbidden(): Response {
  return json({ error: "Forbidden" }, 403);
}

/** Whether `err` is a Postgres unique-constraint violation. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/** A ~64-bit random value in base36 — the uniqueness half of a username. */
function randomSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value.toString(36);
}

/**
 * Generate a username from an email address.
 *
 * `profiles.username` is NOT NULL UNIQUE but `SignupInput` carries NO username
 * field — signup must therefore MINT one. (User-CHOSEN usernames are M1 profile
 * editing; do not add a username field here.)
 *
 * The email local-part is sanitized to `[a-z0-9_]`, truncated, and given a
 * ~64-bit random base36 suffix. The suffix is what makes the result unique:
 * collisions are negligible at that entropy, and `insertProfile` still retries
 * on the unique violation rather than trusting the odds.
 *
 * ⚠️ The sanitized local-part leaks a hint of the email address to anyone who
 * can see the username. That is accepted for the auto-generated M0 default
 * (it is what most platforms do, and the user renames it in M1) — but it is the
 * reason the base is truncated and never the full address.
 */
function generateUsername(email: string): string {
  const local = email.slice(0, email.lastIndexOf("@")).toLowerCase();
  // Strip everything outside the allowed charset; an address whose local-part is
  // entirely non-ASCII sanitizes to "" and falls back to "user".
  const base = local.replace(/[^a-z0-9_]/g, "").slice(0, USERNAME_BASE_MAX);
  return `${base === "" ? "user" : base}_${randomSuffix()}`;
}

/**
 * INSERT the profile row, retrying with a freshly generated username if the
 * `profiles.username` unique index rejects it.
 *
 * The SAVEPOINT is what makes a retry possible at all: in Postgres ANY failed
 * statement poisons the enclosing transaction ("current transaction is aborted"),
 * so without rolling back to a savepoint the retry — and the COMMIT — would fail
 * too. Only a unique violation is retried; anything else propagates and rolls
 * the whole signup back.
 */
async function insertProfile(client: Client, userId: string, email: string): Promise<void> {
  for (let attempt = 1; attempt <= USERNAME_ATTEMPTS; attempt++) {
    await client.query("SAVEPOINT profile_insert");
    try {
      await client.query(
        "INSERT INTO profiles (user_id, username) VALUES ($1, $2)",
        [userId, generateUsername(email)],
      );
      await client.query("RELEASE SAVEPOINT profile_insert");
      return;
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT profile_insert");
      if (!isUniqueViolation(err) || attempt === USERNAME_ATTEMPTS) {
        throw err;
      }
    }
  }
}

/** An existing `users` row matching the signup's email, if any. */
interface ExistingUser {
  id: string;
  email_verified_at: Date | null;
}

/**
 * Handle `POST /auth/signup`. See the file header for the (load-bearing) order.
 */
export async function handleSignup(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // ---- 1. Parse + validate -------------------------------------------------
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    // A malformed body is the client's error, not a 500.
    return json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = SignupInput.safeParse(raw);
  if (!parsed.success) {
    // Only the offending FIELD NAMES are echoed — never the submitted values,
    // one of which is the password.
    return json(
      {
        error: "Invalid signup input",
        fields: parsed.error.issues.map((issue) => issue.path.map(String).join(".")),
      },
      400,
    );
  }
  const { email, password, turnstileToken } = parsed.data;

  // ---- 2. Rate limit -------------------------------------------------------
  // Keyed on ip + email so one address cannot be signup-bombed from many IPs and
  // one IP cannot enumerate many addresses. `CF-Connecting-IP` is absent off
  // Cloudflare (and in tests), hence the stable placeholder for the KEY — but
  // `undefined`, not the placeholder, is what reaches Turnstile below, which
  // expects a real IP or none at all.
  const clientIp = request.headers.get("CF-Connecting-IP");
  const limited = await enforceRateLimit(
    env.SIGNUP_LIMITER,
    `${clientIp ?? "unknown"}:${email}`,
  );
  if (limited !== null) {
    return limited;
  }

  // ---- 3. Turnstile --------------------------------------------------------
  let turnstileOk: boolean;
  try {
    turnstileOk = await verifyTurnstile(env, turnstileToken, clientIp ?? undefined);
  } catch (err) {
    // verifyTurnstile REJECTS on a network/non-JSON failure; its contract says
    // to treat that exactly like a failed verification, never to proceed.
    console.error("turnstile verification errored", err);
    turnstileOk = false;
  }
  if (!turnstileOk) {
    return forbidden();
  }

  // ---- 4. Origin (CSRF) — still before any DB touch ------------------------
  if (!checkOrigin(request)) {
    return forbidden();
  }

  // ---- 5. Duplicate check (FRESH) ------------------------------------------
  // `users.email` is citext, so this match is case-insensitive.
  const existing = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query(
      "SELECT id, email_verified_at FROM users WHERE email = $1",
      [email],
    );
    return (rows[0] ?? null) as ExistingUser | null;
  });

  // A VERIFIED address has a proven owner — signup stops here.
  if (existing !== null && existing.email_verified_at !== null) {
    return json({ error: "Email already registered" }, 409);
  }

  // Hashed OUTSIDE the transaction below: Argon2id is deliberately slow (~19MiB,
  // 2 passes), and holding a Hyperdrive connection open across it would burn a
  // pooled connection for the duration of every signup.
  const passwordHash = await hashPassword(password);

  // ---- 6. Single transaction -----------------------------------------------
  const userId = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    await c.query("BEGIN");
    try {
      let id: string;

      if (existing === null) {
        const { rows } = await c.query(
          "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
          [email, passwordHash],
        );
        id = rows[0].id as string;
        await insertProfile(c, id, email);
      } else {
        // RE-SIGNUP over an UNVERIFIED account (`email_verified_at IS NULL`).
        //
        // An unverified account has no PROVEN owner: anyone can type any address
        // into the form, so the row only records that someone claimed it. Letting
        // a later signup take it over is therefore safe, and it is what keeps
        // this path enumeration-resistant — 409ing here would confirm the address
        // is registered, and falling through to the INSERT would hit the
        // `users.email` unique index and 500.
        //
        // The user id is DELIBERATELY preserved (no delete + re-insert), and the
        // existing `profiles` row is left alone: its PK is `user_id`, so a second
        // insert would violate it. Only the password changes; a fresh
        // verification token + session follow below exactly as for a new signup.
        await c.query("UPDATE users SET password_hash = $1 WHERE id = $2", [
          passwordHash,
          existing.id,
        ]);
        id = existing.id;
      }

      await c.query("COMMIT");
      return id;
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }
  });

  // ---- 7. Verification email -----------------------------------------------
  const token = await createVerificationToken(env, userId);
  // `checkOrigin` passed above, so a present `Origin` is one of the allowlisted
  // values in src/auth/csrf.ts — trusted, and correct for local dev too.
  const origin = request.headers.get("Origin") ?? CANONICAL_ORIGIN;
  const verifyUrl = `${origin}/verify-email?token=${encodeURIComponent(token)}`;
  // NEVER throws (src/auth/email-verify.ts): the account already exists by now,
  // so a Postmark outage must not turn a successful signup into a 500. The user
  // can request another email.
  await sendVerificationEmail(env, email, verifyUrl);

  // ---- 8. Security epoch ---------------------------------------------------
  const securityEpoch = await env.USER_SECURITY.getByName(userId).getEpoch();

  // ---- 9. Session ----------------------------------------------------------
  const { cookie } = await createSession(env, {
    userId,
    // No roles at signup: a fresh account is a plain member. Roles are granted
    // out of band, never self-assigned by the signup payload.
    roles: [],
    securityEpoch,
    // A FRESH 32-byte secret per session — never derived from the user, the
    // password, or anything guessable. The client only ever sees its sha256
    // (src/auth/csrf.ts).
    csrfSecret: base64urlEncode(crypto.getRandomValues(new Uint8Array(32))),
    createdAt: Date.now(),
  });

  // ---- 10. 201 + Set-Cookie ------------------------------------------------
  return json({ userId }, 201, { "Set-Cookie": cookie });
}
