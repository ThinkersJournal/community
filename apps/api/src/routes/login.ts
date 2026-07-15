/**
 * `POST /auth/login` — exchange an email + password for a session.
 *
 * ORDER is load-bearing, same discipline as src/routes/signup.ts:
 *
 *   1. zod validation      — reject garbage before spending any quota.
 *   2. origin check        — CSRF. A pure header check with ZERO I/O, so it is
 *                            free to run first — and it must, see below.
 *   3. rate limit          — bounds every step below, including the Argon2id
 *                            verify, which is deliberately expensive and
 *                            therefore a DoS lever if unbounded.
 *   4. lookup (FRESH)      — `SELECT id, password_hash`.
 *   5. verify              — generic 401 on ANY failure (see below).
 *   6. rehash-on-upgrade   — ONLY after a successful verify.
 *   7. security epoch      — read fresh from the DO, stamped into the session.
 *   8. session             — opaque KV token.
 *   9. 200 + Set-Cookie.
 *
 * ⚠️ CHECKORIGIN RECONCILIATION: the task brief's step list for this route
 * does not mention an origin check, but the Global Constraints require an
 * Origin/Referer allowlist check on EVERY non-GET request before it touches
 * the DB, and src/routes/signup.ts already does this for the sibling auth
 * route. Login has no session yet at request time, so only `checkOrigin`
 * (the Origin/Referer allowlist) applies — there is no `csrfSecret` to echo
 * back yet, so the double-submit `checkCsrf` does not apply here either
 * (same reasoning as signup's origin step).
 *
 * ⚠️ ORIGIN BEFORE THE LIMITER — a DELIBERATE deviation from the brief's literal
 * step order, matching the rule src/auth/pipeline.ts states for every other
 * mutating route: "rate limit last: quota is spent only by a request that is
 * otherwise fully entitled to proceed, so unauthenticated noise cannot burn a
 * real user's budget." Spending quota BEFORE the origin check inverted that, and
 * on THIS route the consequence is a working denial-of-login: a page on evil.com
 * makes a victim's browser POST here with the victim's address (a `text/plain`
 * body dodges the CORS preflight, so the request really is sent even though the
 * attacker cannot read the reply), and each one burns a slot in that victim's
 * OWN bucket before 403ing — ~10 of them and the victim cannot log in for up to
 * 60s. The origin check is a pure header comparison with no I/O, so nothing is
 * lost by moving it up, and both orders satisfy the binding constraint that
 * `checkOrigin` run before the DB is touched.
 *
 * ⚠️ NO TURNSTILE: unlike signup, login has no Turnstile step in either the
 * brief or the REUSE list — `enforceRateLimit` is the only bot/brute-force
 * defense here, matching the reuse contract exactly (YAGNI: do not invent a
 * step the task did not ask for). That makes the limiter's keying (step 3)
 * load-bearing rather than merely defensive: it is the WHOLE brute-force
 * defense on this route.
 *
 * ⚠️ Every DB access goes through `HYPERDRIVE_FRESH` (cache-disabled) for the
 * same reason as signup: this is an auth read/write, and Hyperdrive never
 * invalidates on write, so a `HYPERDRIVE_CACHED` read here would be a real
 * security bug.
 *
 * ⚠️ NO USER ENUMERATION — two defenses, BOTH required:
 *
 *   (a) BODY/STATUS: a nonexistent email and a wrong password return the
 *       exact same `unauthorized()` response (401, identical JSON body).
 *       Without this, the error text alone would tell an attacker whether an
 *       address is registered.
 *
 *   (b) TIMING: a byte-identical body is not sufficient on its own. A wrong
 *       password burns a full Argon2id verify (~40-60ms at the current
 *       params); a nonexistent email that skipped verification entirely
 *       would return in ~0ms. That latency gap is itself a working
 *       enumeration oracle even though the two responses are byte-identical.
 *       So the nonexistent-email path ALSO runs a full `verifyPassword` call
 *       — against `DUMMY_HASH` below — and discards the result, spending the
 *       same Argon2id cost before returning the same 401. See `DUMMY_HASH`'s
 *       own comment for how that constant was produced.
 */
import { LoginInput } from "@thinkersjournal/shared";

import { checkOrigin } from "../auth/csrf";
import { base64urlEncode } from "../auth/encoding";
import { hashPassword, needsRehash, verifyPassword } from "../auth/password";
import { enforceRateLimit } from "../auth/ratelimit";
import { createSession } from "../auth/session";
import { withClient } from "../db/client";

/**
 * A fixed, valid Argon2id PHC hash used ONLY to equalize timing on the
 * nonexistent-email path (see the file header, "NO USER ENUMERATION" (b)).
 * Its verify result is always discarded — no login ever legitimately matches
 * it, because no user's password is derived from it.
 *
 * Produced OFFLINE, once, with `CURRENT_ARGON2_PARAMS` (src/auth/password.ts:
 * m=19456, t=2, p=1) over a fixed 16-byte salt and an arbitrary fixed
 * password, using the same `argon2id` WASM module `hashPassword` uses. It is
 * hardcoded (not computed at request time, and not even lazily at module
 * load) so that spending its cost never depends on anything request-shaped —
 * a `let dummyHashPromise` memoized-at-first-use scheme would make the FIRST
 * nonexistent-email request in a given isolate slower than a wrong-password
 * request until the memo warms, which is its own (smaller) timing tell.
 *
 * ⚠️ Must be regenerated if `CURRENT_ARGON2_PARAMS` ever changes, so the dummy
 * verify keeps costing the same as a real one on the current baseline.
 *
 * ⚠️ EXPORTED SOLELY SO A TEST CAN PIN IT — this is not part of the route's
 * API and nothing else should import it. The invariant that matters is
 * `needsRehash(DUMMY_HASH) === false`, which test/login.test.ts asserts,
 * because this control degrades SILENTLY in both directions:
 *   (a) if `CURRENT_ARGON2_PARAMS` is raised and this constant is not
 *       regenerated, it becomes a WEAK-param hash — the no-row path then costs
 *       far less than a real verify and the timing oracle quietly returns,
 *       with every functional test still green;
 *   (b) if it were malformed, `parsePhc` returns null and `verifyPassword`
 *       returns false in ~0ms without throwing — the control is simply gone,
 *       again with every test still green.
 * `needsRehash` returns `true` for an unparseable hash AND for drifted params,
 * so that one assertion covers both failure modes at zero flake risk (it is a
 * pure string/param check — no timing measurement involved).
 */
export const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$QkJCQkJCQkJCQkJCQkJCQg$uREWjDiAO3pY5UG33fbKbLCW2BBdEoCNm7s5sr8Admo";

/** A `users` row as read by the login lookup. */
interface UserRow {
  id: string;
  password_hash: string;
}

function json(body: unknown, status: number, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * The ONE 401 returned for every failed-credentials case: a nonexistent
 * email and a wrong password are indistinguishable from this response alone.
 * See the file header's "NO USER ENUMERATION" note — this is defense (a);
 * defense (b) is what makes both call sites take comparably long to reach it.
 */
function unauthorized(): Response {
  return json({ error: "Invalid email or password" }, 401);
}

/**
 * Handle `POST /auth/login`. See the file header for the (load-bearing) order.
 */
export async function handleLogin(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // ---- 1. Parse + validate --------------------------------------------------
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    // A malformed body is the client's error, not a 500.
    return json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = LoginInput.safeParse(raw);
  if (!parsed.success) {
    // Only the offending FIELD NAMES are echoed — never the submitted values,
    // one of which is the password.
    return json(
      {
        error: "Invalid login input",
        fields: parsed.error.issues.map((issue) => issue.path.map(String).join(".")),
      },
      400,
    );
  }
  const { email, password } = parsed.data;

  // ---- 2. Origin (CSRF) — before the limiter, and before any I/O -------------
  // See the file header's CHECKORIGIN RECONCILIATION and ORIGIN BEFORE THE
  // LIMITER notes.
  if (!checkOrigin(env, request)) {
    return json({ error: "Forbidden" }, 403);
  }

  // ---- 3. Rate limit ---------------------------------------------------------
  // TWO buckets, and BOTH are required — they bound different attacks:
  //
  //   (a) `ip:email` — one IP cannot brute-force many addresses.
  //   (b) `email`    — one ADDRESS has a ceiling no matter how many IPs the
  //                    attempts come from. This is the credential-stuffing case.
  //
  // ⚠️ (b) IS NOT REDUNDANT, and (a) DOES NOT IMPLY IT. Putting the IP IN the
  // key gives every IP its own private bucket, so N IPs against one address get
  // N × 10 attempts per window — a botnet trivially defeats (a) alone, and with
  // NO Turnstile on this route (see above) the limiter is the only thing
  // standing between an attacker and unlimited password guesses. Only a key
  // WITHOUT the IP in it can bound the total against a single address. (This
  // file used to claim the single `ip:email` key gave both properties; it never
  // did — only the "one IP cannot spray many addresses" half was ever true.)
  //
  // `CF-Connecting-IP` is absent off Cloudflare (and in tests), hence the
  // stable placeholder. The `email:` prefix on (b) cannot practically collide
  // with (a)'s `<ip>:<email>` shape: Cloudflare sets `CF-Connecting-IP` itself,
  // so it is never the literal string "email" — and were it ever spoofed to
  // collide, the two keys would merely SHARE a bucket, which is stricter.
  //
  // ⚠️ `email` here is the PARSED value, which `LoginInput` has already
  // lowercased — do NOT rebuild either key from the raw request body. The DB
  // lookup below is citext (case-INsensitive), so a case-sensitive key would
  // let `Victim@…` and `victim@…` hit the same user row via DIFFERENT limiter
  // buckets: case-rotating the address then multiplies the 10/60s ceiling by
  // the number of variants and nullifies this defense entirely. See the
  // NormalizedEmail note in packages/shared/src/schemas.ts.
  //
  // ⚠️ THE BINDING IS NOT AN ACCURATE COUNTER — see src/auth/ratelimit.ts's
  // header. Cloudflare's limit is per key PER LOCATION and eventually
  // consistent, so (b) is a real ceiling per Cloudflare location, not a global
  // one. It still collapses an unbounded per-IP multiplier down to a bounded
  // per-location one, which is the property being bought here.
  const clientIp = request.headers.get("CF-Connecting-IP");
  const ipLimited = await enforceRateLimit(
    env.LOGIN_LIMITER,
    `${clientIp ?? "unknown"}:${email}`,
  );
  if (ipLimited !== null) {
    return ipLimited;
  }
  const emailLimited = await enforceRateLimit(env.LOGIN_LIMITER, `email:${email}`);
  if (emailLimited !== null) {
    return emailLimited;
  }

  // ---- 4. Lookup (FRESH) ------------------------------------------------------
  // `users.email` is citext, so this match is case-insensitive.
  const row = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query(
      "SELECT id, password_hash FROM users WHERE email = $1",
      [email],
    );
    return (rows[0] ?? null) as UserRow | null;
  });

  // ---- 5. Verify --------------------------------------------------------------
  if (row === null) {
    // NO USER ENUMERATION (b): still pay a full Argon2id verify so this path
    // costs about the same as a wrong-password rejection below. The result is
    // never used for anything — see `DUMMY_HASH`'s comment.
    await verifyPassword(password, DUMMY_HASH);
    return unauthorized();
  }

  const passwordOk = await verifyPassword(password, row.password_hash);
  if (!passwordOk) {
    return unauthorized();
  }

  // ---- 6. Rehash-on-upgrade — ONLY after a successful verify -----------------
  // A stronger baseline than what this hash was produced with: re-hash the
  // password we JUST verified (plaintext still in hand) with the CURRENT
  // params, so the row silently upgrades on the user's next successful login
  // instead of requiring a bulk migration.
  //
  // ⚠️ NEVER FAILS THE LOGIN. This is an OPPORTUNISTIC upgrade riding on an
  // authentication that has ALREADY succeeded — the caller proved they know the
  // password at step 5. Letting a transient Postgres blip here escape would
  // turn a correct password into a 500 and lock a legitimate user out over
  // something entirely incidental to their credentials. On failure we log and
  // proceed: the user gets their session, the row keeps its old (still valid,
  // merely weaker) hash, and the next successful login retries the upgrade.
  if (needsRehash(row.password_hash)) {
    try {
      const freshHash = await hashPassword(password);
      await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
        c.query("UPDATE users SET password_hash = $1 WHERE id = $2", [
          freshHash,
          row.id,
        ]),
      );
    } catch (err) {
      // The error only — NEVER the password, the old hash, or the new one.
      console.error("password rehash-on-upgrade failed; login proceeds", err);
    }
  }

  // ---- 7. Security epoch ------------------------------------------------------
  // Read fresh from the DO so the session carries the CURRENT epoch, not a
  // value that might already be stale (e.g. a concurrent "log out everywhere").
  const securityEpoch = await env.USER_SECURITY.getByName(row.id).getEpoch();

  // ---- 8. Session ---------------------------------------------------------
  const { cookie } = await createSession(env, {
    userId: row.id,
    // Login never grants roles — a session's roles come from the account's
    // existing state, not from anything the login payload can influence.
    // M0 has no role storage/lookup yet, so this mirrors signup's plain
    // member default; role assignment is out of band, never self-asserted.
    roles: [],
    securityEpoch,
    // A FRESH 32-byte secret per session — never derived from the user, the
    // password, or anything guessable. The client only ever sees its sha256
    // (src/auth/csrf.ts).
    csrfSecret: base64urlEncode(crypto.getRandomValues(new Uint8Array(32))),
    createdAt: Date.now(),
  });

  // ---- 9. 200 + Set-Cookie ------------------------------------------------
  return json({ userId: row.id }, 200, { "Set-Cookie": cookie });
}
