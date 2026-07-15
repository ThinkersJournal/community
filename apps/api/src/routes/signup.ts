/**
 * `POST /auth/signup` — the route that composes every auth primitive built so
 * far. The ORDER of its steps is load-bearing and must not be rearranged:
 *
 *   1. zod validation      — reject garbage before spending any quota.
 *   2. origin check        — CSRF. A pure header check with ZERO I/O, so it is
 *                            free to run first — and it must, see below.
 *   3. rate limit          — bounds every step below (incl. the Turnstile call
 *                            and the Argon2id hash, which is deliberately
 *                            expensive and therefore a DoS lever if unbounded).
 *   4. Turnstile           — bot defense.
 *   5. atomic upsert (FRESH) — ONE transaction, ONE guarded statement:
 *                            verified dup -> 409; unverified dup -> re-signup;
 *                            new -> create. Contains the epoch bump, which is
 *                            issued BEFORE the COMMIT (see the step's note).
 *   6. verification email  — never fails the signup (see step note below).
 *   7. security epoch      — read AFTER the bump, stamped into the session.
 *   8. session             — opaque KV token.
 *   9. 201 + Set-Cookie.
 *
 * ⚠️ ORIGIN BEFORE THE LIMITER — this is a DELIBERATE deviation from the task
 * brief's literal step order, and it matches the rule src/auth/pipeline.ts
 * states for every other mutating route: "rate limit last: quota is spent only
 * by a request that is otherwise fully entitled to proceed, so unauthenticated
 * noise cannot burn a real user's budget." Spending quota BEFORE the origin
 * check inverted that. A page on evil.com can make a victim's browser POST here
 * with the victim's address (a `text/plain` body dodges the CORS preflight, so
 * the request is genuinely sent even though the attacker cannot read the reply);
 * the request then 403s — but only AFTER burning a slot in that victim's own
 * bucket, so a few of them lock the victim out of signing up for up to 60s. The
 * origin check is a pure header comparison with no I/O, so nothing is lost by
 * moving it up, and both orders satisfy the binding constraint that `checkOrigin`
 * run before the DB is touched.
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
  verificationLinkOrigin,
} from "../auth/email-verify";
import { base64urlEncode } from "../auth/encoding";
import { hashPassword } from "../auth/password";
import { enforceRateLimit } from "../auth/ratelimit";
import { createSession } from "../auth/session";
import { verifyTurnstile } from "../auth/turnstile";
import { withClient } from "../db/client";
import { isUniqueViolation } from "../db/errors";
import { errorResponse } from "../http/errors";
import { randomSuffix } from "../util/random";

import type { Client } from "pg";

/** Longest sanitized email local-part kept as a generated username's base. */
const USERNAME_BASE_MAX = 20;

/** Attempts to place a generated username before giving up (see `insertProfile`). */
const USERNAME_ATTEMPTS = 3;

/**
 * The 403 returned for BOTH a failed Turnstile challenge and a rejected origin.
 * One shared response keeps the two defenses from being probed apart.
 */
function forbidden(): Response {
  return errorResponse("FORBIDDEN", 403);
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
 *
 * ⚠️ TWO DIFFERENT UNIQUE INDEXES, ONLY ONE OF THEM SWALLOWED. `ON CONFLICT
 * (user_id) DO NOTHING` names the PK alone, so a re-signup over a user that
 * ALREADY has a profile is a silent no-op (that is the point — the caller runs
 * this on every path and no longer has to assume the row is there). A
 * `profiles.username` collision is a different index, is NOT covered by that
 * conflict target, and still surfaces as 23505 — which is exactly what the retry
 * loop below needs, since the mint-a-new-suffix recovery only makes sense for
 * the username. Do not widen the target to `DO NOTHING` on every conflict: that
 * would swallow username collisions into a signup that silently has no profile.
 */
async function insertProfile(client: Client, userId: string, email: string): Promise<void> {
  for (let attempt = 1; attempt <= USERNAME_ATTEMPTS; attempt++) {
    await client.query("SAVEPOINT profile_insert");
    try {
      await client.query(
        `INSERT INTO profiles (user_id, username) VALUES ($1, $2)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, generateUsername(email)],
      );
      await client.query("RELEASE SAVEPOINT profile_insert");
      return;
    } catch (err) {
      // The recovery gets its OWN try/catch so it cannot REPLACE the root error:
      // on a dead connection this ROLLBACK throws too, and an escaping rollback
      // failure would bury `err` — the actual cause — leaving a "connection
      // terminated" in the logs with no trace of what really went wrong.
      let recovered = true;
      try {
        await client.query("ROLLBACK TO SAVEPOINT profile_insert");
      } catch (rollbackErr) {
        recovered = false;
        console.error(
          "ROLLBACK TO SAVEPOINT after a failed profile insert failed",
          rollbackErr,
        );
      }

      // Retry ONLY a username collision we actually rolled back: without the
      // savepoint rollback the transaction stays poisoned ("current transaction
      // is aborted"), so a retry — and the COMMIT — would fail anyway. Either
      // way `err`, not the rollback failure, is what propagates.
      if (!recovered || !isUniqueViolation(err) || attempt === USERNAME_ATTEMPTS) {
        throw err;
      }
    }
  }
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
    return errorResponse("INVALID_JSON", 400);
  }

  const parsed = SignupInput.safeParse(raw);
  if (!parsed.success) {
    // Only the offending FIELD NAMES are echoed — never the submitted values,
    // one of which is the password.
    return errorResponse("INVALID_INPUT", 400, {
      fields: parsed.error.issues.map((issue) => issue.path.map(String).join(".")),
    });
  }
  const { email, password, turnstileToken } = parsed.data;

  // ---- 2. Origin (CSRF) — before the limiter, and before any I/O -----------
  // See the file header's ORIGIN BEFORE THE LIMITER note: quota must only ever
  // be spent by a request that is otherwise entitled to proceed.
  if (!checkOrigin(env, request)) {
    return forbidden();
  }

  // ---- 3. Rate limit -------------------------------------------------------
  // TWO buckets, and BOTH are required — they bound different attacks:
  //
  //   (a) `ip:email` — one IP cannot enumerate/signup-bomb many addresses.
  //   (b) `email`    — one ADDRESS has a ceiling no matter how many IPs it is
  //                    attacked from.
  //
  // ⚠️ (b) IS NOT REDUNDANT, and (a) DOES NOT IMPLY IT. Putting the IP IN the
  // key gives every IP its own private bucket, so N IPs against one address get
  // N × the limit per window — a botnet trivially defeats (a) alone. Only a key
  // WITHOUT the IP in it can bound the total against a single address. (This
  // file used to claim the single `ip:email` key gave both properties; it never
  // did — only the "one IP cannot spray many addresses" half was ever true.)
  //
  // `CF-Connecting-IP` is absent off Cloudflare (and in tests), hence the stable
  // placeholder for the KEY — but `undefined`, not the placeholder, is what
  // reaches Turnstile below, which expects a real IP or none at all.
  //
  // The `email:` prefix on (b) cannot practically collide with (a)'s
  // `<ip>:<email>` shape: Cloudflare sets `CF-Connecting-IP` itself, so it is
  // never the literal string "email" — and were it ever spoofed to collide, the
  // two keys would merely SHARE a bucket, which is stricter, not weaker.
  //
  // ⚠️ `email` here is the PARSED value, which `SignupInput` has already
  // lowercased — do NOT rebuild either key from the raw request body. The dup
  // check below is citext (case-INsensitive), so a case-sensitive key would let
  // `Victim@…` and `victim@…` contend for the same row via DIFFERENT limiter
  // buckets, multiplying this limiter's ceiling by the number of case variants.
  // See the NormalizedEmail note in packages/shared/src/schemas.ts.
  //
  // ⚠️ THE BINDING IS NOT AN ACCURATE COUNTER — see src/auth/ratelimit.ts's
  // header. Cloudflare's limit is per key PER LOCATION and eventually
  // consistent, so (b) is a real ceiling per Cloudflare location, not a global
  // one. It still collapses an unbounded per-IP multiplier down to a bounded
  // per-location one, which is the property being bought here.
  const clientIp = request.headers.get("CF-Connecting-IP");
  const ipLimited = await enforceRateLimit(
    env.SIGNUP_LIMITER,
    `${clientIp ?? "unknown"}:${email}`,
  );
  if (ipLimited !== null) {
    return ipLimited;
  }
  const emailLimited = await enforceRateLimit(env.SIGNUP_LIMITER, `email:${email}`);
  if (emailLimited !== null) {
    return emailLimited;
  }

  // ---- 4. Turnstile --------------------------------------------------------
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

  // Hashed OUTSIDE the transaction below: Argon2id is deliberately slow (~19MiB,
  // 2 passes), and holding a Hyperdrive connection open across it would burn a
  // pooled connection for the duration of every signup.
  const passwordHash = await hashPassword(password);

  // ---- 5. Atomic guarded upsert (FRESH) ------------------------------------
  //
  // ⚠️ ONE STATEMENT, NOT check-then-act. M0 ran `SELECT … WHERE email = $1` and
  // then, separately, INSERTed — with the Argon2id hash above sitting BETWEEN
  // them, which made it the widest check-then-act window in the codebase. Under
  // a TRANSACTION-MODE pooler that is a race by construction: two concurrent
  // signups for one address both read "no row", both INSERT, and the second dies
  // on `users_email_key` as a 500. This is the Global Constraint the rest of the
  // Worker already follows — "all uniqueness/races via DB constraints +
  // INSERT … ON CONFLICT" — and signup was the one place disobeying it.
  //
  // HOW THE GUARD ENCODES THE POLICY:
  //   • no row          -> the INSERT wins    -> `inserted = true`, a new account
  //   • row, UNVERIFIED -> the DO UPDATE fires -> `inserted = false`, a re-signup
  //   • row, VERIFIED   -> the WHERE blocks it -> ZERO ROWS
  //
  // ⚠️ ZERO ROWS IS THE 409, AND ONLY THE DATABASE CAN DECIDE IT. `WHERE
  // users.email_verified_at IS NULL` on the DO UPDATE means a conflict with a
  // verified row updates NOTHING and returns NOTHING — so `rows.length === 0` is
  // unambiguously "a verified account owns this address", decided atomically
  // rather than by a read anything could have invalidated between check and act.
  //
  // ⚠️ THE `WHERE` IS THE WHOLE SECURITY PROPERTY. M0 rejected an UNGUARDED
  // `ON CONFLICT DO UPDATE` precisely because it would let any stranger's signup
  // overwrite a VERIFIED account's password — a one-request account takeover of
  // a proven owner. This guarded form is the answer M0 was missing, not a
  // relaxation of its finding. test/signup.test.ts pins it.
  //
  // ⚠️ DOES NOT 409 THE UNVERIFIED PATH, DELIBERATELY: that would confirm to an
  // enumerator that the address is registered. An unverified row has no PROVEN
  // owner — anyone can type any address into the form — so a later signup takes
  // it over, preserving the user id (no delete + re-insert).
  //
  // `xmax = 0` is the standard way to ask "did this row come from the INSERT or
  // the UPDATE"; the bump below must fire ONLY on the takeover path.
  const upserted = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    await c.query("BEGIN");
    try {
      const { rows } = await c.query<{ id: string; inserted: boolean }>(
        `INSERT INTO users (email, password_hash)
              VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE
                 SET password_hash = EXCLUDED.password_hash
               WHERE users.email_verified_at IS NULL
           RETURNING id, (xmax = 0) AS inserted`,
        [email, passwordHash],
      );

      const row = rows[0] ?? null;
      if (row === null) {
        // A VERIFIED account owns this address. Nothing was written.
        await c.query("ROLLBACK");
        return null;
      }

      // ---- Epoch bump — RE-SIGNUP ONLY, and BEFORE THE COMMIT ---------------
      // ⚠️ LOAD-BEARING SECURITY STEP, and half of the account-takeover fix
      // documented at the top of src/routes/verify-email.ts. Taking over an
      // unverified account changes its password, so every session issued against
      // the OLD password must die. Bumping the epoch does that in O(1): each of
      // those sessions carries a now-stale `securityEpoch` and fails the
      // revocation check. WITHOUT it, the previous claimant's surviving session
      // satisfies that route's auth checks by itself and their click on the old
      // emailed link verifies an account holding SOMEONE ELSE'S password. Do not
      // remove; test/signup.test.ts pins this.
      //
      // ⚠️ ORDER: INSIDE the transaction, BEFORE the COMMIT — NOT after it.
      // Revoke-then-mutate is the fail-safe direction and it survives the move to
      // an upsert intact, because what matters is not which line runs first but
      // what is OBSERVABLE. The bump is a Durable Object call and is NOT part of
      // this transaction, so the two can fail independently:
      //   • bump throws  -> the catch below ROLLS BACK -> the new password never
      //                     existed. The OLD password stays live and nothing was
      //                     granted. Harmless.
      //   • COMMIT throws after a successful bump -> the password never changes
      //                     and the previous claimant is merely logged out of an
      //                     account nobody took over. Harmless — and unverified
      //                     accounts cannot mutate content anyway (auth/pipeline).
      // Committing FIRST and bumping after would invert this into the takeover
      // state: the attacker's password live, the victim's session UNREVOKED and
      // its epoch still MATCHING, so the victim's own click on their emailed link
      // verifies an account holding the attacker's password. `bumpEpoch` is
      // load-bearing precisely WHEN it fails, so "it is only a crash window" is
      // not a defense. The COMMIT is the gate: no observer can ever see the new
      // password unless the bump already succeeded.
      //
      // The cost is that the re-signup path holds this connection and the row's
      // lock across one DO round-trip. That is bounded, far cheaper than the
      // Argon2id hash already done above (outside the tx), and only on re-signup.
      if (!row.inserted) {
        await env.USER_SECURITY.getByName(row.id).bumpEpoch();
      }

      // Runs on EVERY path, not just the insert: `ON CONFLICT (user_id) DO
      // NOTHING` makes it a no-op when the profile is already there, so a
      // re-signup no longer has to ASSUME the unverified row has one — a user
      // without a profile heals here instead. Note the two ON CONFLICTs target
      // DIFFERENT indexes: `profiles.user_id` (swallowed) and `profiles.username`
      // (still raised as 23505, still retried under the savepoint).
      await insertProfile(c, row.id, email);

      await c.query("COMMIT");
      return row;
    } catch (err) {
      // The ROLLBACK gets its OWN try/catch so it cannot REPLACE the root error:
      // if the connection is dead, ROLLBACK throws too and `throw err` below
      // would never run — the caller would see "connection terminated" instead of
      // whatever actually failed the signup.
      try {
        await c.query("ROLLBACK");
      } catch (rollbackErr) {
        console.error(
          "ROLLBACK after a failed signup transaction failed",
          rollbackErr,
        );
      }
      throw err;
    }
  });

  // Zero rows came back: a VERIFIED account owns this address (see the guard).
  if (upserted === null) {
    return errorResponse("EMAIL_TAKEN", 409);
  }
  const userId = upserted.id;

  // ---- 6. Verification email -----------------------------------------------
  const token = await createVerificationToken(env, userId);
  // Restricted to PRODUCTION origins — NOT every origin `checkOrigin` accepts.
  // See `verificationLinkOrigin`: a non-browser client can set any Origin it
  // likes, and the one place that must never honor a localhost Origin is a link
  // we mail to a real user.
  const verifyUrl = `${verificationLinkOrigin(request)}/verify-email?token=${encodeURIComponent(token)}`;
  // NEVER throws (src/auth/email-verify.ts): the account already exists by now,
  // so a Postmark outage must not turn a successful signup into a 500. The user
  // can request another email.
  await sendVerificationEmail(env, email, verifyUrl);

  // ---- 7. Security epoch ---------------------------------------------------
  // Read AFTER step 5's bump, so a re-signup's new session carries the POST-bump
  // epoch. Reading it before the bump would stamp the session with a value the
  // bump immediately invalidates — logging the new owner straight back out.
  const securityEpoch = await env.USER_SECURITY.getByName(userId).getEpoch();

  // ---- 8. Session ----------------------------------------------------------
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

  // ---- 9. 201 + Set-Cookie -------------------------------------------------
  return new Response(JSON.stringify({ userId }), {
    status: 201,
    headers: { "content-type": "application/json", "Set-Cookie": cookie },
  });
}
