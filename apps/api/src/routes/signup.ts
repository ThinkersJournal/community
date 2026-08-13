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
import { RESERVED_USERNAMES } from "../auth/reserved-usernames";
import { createSession } from "../auth/session";
import { verifyTurnstile } from "../auth/turnstile";
import { suggestUsernames } from "../auth/username-suggest";
import { BEGIN_BOUNDED_TX, withClient } from "../db/client";
import { isUniqueViolation } from "../db/errors";
import { errorResponse } from "../http/errors";

/**
 * The 403 returned for BOTH a failed Turnstile challenge and a rejected origin.
 * One shared response keeps the two defenses from being probed apart.
 */
function forbidden(): Response {
  return errorResponse("FORBIDDEN", 403);
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
  const { email, password, username, turnstileToken } = parsed.data;

  // Pure, no-I/O — belongs with the zod validation above, not with the
  // I/O-bearing checks below. `username` is already trimmed + lowercased by
  // `SignupInput`, matching the (also-lowercase) `RESERVED_USERNAMES` entries.
  if (RESERVED_USERNAMES.has(username)) {
    return errorResponse("INVALID_INPUT", 400, {
      fields: ["username"],
      message: "That handle is reserved.",
    });
  }

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
  //
  // It is idiom rather than documented contract, but the SECURITY-RELEVANT
  // direction is safe BY MECHANISM, not by luck: `ON CONFLICT DO UPDATE` always
  // locks the conflicting tuple first, and `heap_update` carries that locker into
  // the new tuple's `xmax` — so an UPDATED row's xmax is never 0, and an update
  // can never be misreported as an insert. That is the direction that would skip
  // the bump. It is additionally pinned by executable consequence, not just by
  // reading: the re-signup epoch test and the account-takeover regression in
  // test/signup.test.ts both depend on `inserted === false` firing the bump
  // against real Postgres, so drift breaks them loudly. Residual gap:
  // test/postgres-version.db.test.ts asserts `>= 18`, so it would not catch a
  // behavior change on some FUTURE major — re-verify this idiom when upgrading.
  // ⚠️ WRAPPED IN A try/catch — the ONLY unique violation that can escape this
  // transaction is `profiles.username`: `users.email` and `profiles.user_id`
  // are both named by an `ON CONFLICT ... DO UPDATE` above/below, so neither
  // can raise 23505. A username collision therefore means exactly one thing —
  // someone else already holds the chosen handle — and is translated to a 409
  // with a few available alternatives. Anything else rethrows unchanged.
  let upserted: { id: string; inserted: boolean } | null;
  try {
    upserted = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      // NOT a bare `BEGIN`: this transaction holds a row lock across the epoch
      // bump's DO RPC below, so its lock hold is bounded database-side. See
      // `BEGIN_BOUNDED_TX` in src/db/client.ts for the values and why they cannot
      // live on the connection.
      await c.query(BEGIN_BOUNDED_TX);
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
        // UPDATE` both heals a user row that somehow has no profile (insert) AND
        // lets a re-signup change its handle (update) — a re-signup no longer has
        // to ASSUME the unverified row's existing username is the one being kept.
        // Note the two ON CONFLICTs target DIFFERENT indexes: `profiles.user_id`
        // (handled here, always succeeds) and `profiles.username` (NOT a conflict
        // target of this statement, so a collision still raises 23505 and is
        // caught by the try/catch wrapping this whole transaction below).
        await c.query(
          `INSERT INTO profiles (user_id, username) VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username`,
          [row.id, username],
        );

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
  } catch (err) {
    if (isUniqueViolation(err)) {
      // A fresh connection: the one above is already being torn down by
      // `withClient`'s `finally`, and its transaction rolled back above.
      const suggestions = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
        suggestUsernames(c, username),
      );
      return errorResponse("USERNAME_TAKEN", 409, {
        fields: ["username"],
        suggestions,
      });
    }
    throw err;
  }

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
