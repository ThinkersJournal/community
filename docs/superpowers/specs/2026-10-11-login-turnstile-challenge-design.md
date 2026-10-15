# Turnstile challenge after repeated login failures — design note

**Status:** DECIDED and BUILT behind the `LOGIN_CHALLENGE` flag (off), same change as the rulings in §9.
Originally design only, with no threshold change. Written 2026-10-11 against `origin/main` e3b6fb6
(package version 0.1.12). Every `file:line` below is at that ref; re-read before building.

**Founder:** CireSnave 2026-10-11 (relayed by the PM, verbatim): *"There's nothing stopping us and it seems
like a good idea."* The widget's hostnames already include `community.thinkersjournal.com`.

## 0. Summary and recommendation

| Question | Answer |
|---|---|
| State the design reads | **A new, lower "soft" rate-limit binding**, keyed exactly like the existing hard caps. No new store. The three existing hard caps keep their numbers and run first, unchanged. (§1) |
| Existence oracle | The soft keys are built from the attempted email string and the IP, consumed **before** the account lookup. (§2) |
| Lockout-by-victim | The challenge can only *add* a requirement to an attempt; it never denies one. (§3) |
| Solving services | A solved token buys one attempt's entry to verification. It does not touch a hard cap. (§4) |
| siteverify down | Fail closed for the challenged attempt only (503), log a `security:` line, unchallenged logins never call it. (§5) |
| Ships | Behind an api env flag, **off**, so web and api can deploy in either order. (§7) |

The decisions that were CireSnave's are recorded as DECIDED in §9 (2026-10-11).

## 1. What state can the design read?

**Facts at e3b6fb6.**

- The Cloudflare rate-limit binding returns only `{ success }` (`apps/api/src/auth/ratelimit.ts:70`).
  There is no read-without-consume and no count. The header says so itself (`ratelimit.ts:18-37`:
  "intentionally designed to not be used as an accurate accounting system", per location, eventually
  consistent).
- Login consumes three buckets before any lookup: `ip:<limiterIpKey>` on `LOGIN_IP_LIMITER` 30/60s
  (`login.ts:282`, `wrangler.jsonc` namespace 1013), `<ip>:<email>` on `LOGIN_LIMITER` 10/60s
  (`login.ts:291`), `email:<email>` on `LOGIN_LIMITER` 10/60s (`login.ts:299`). `period` can only be 10 or
  60 (`wrangler.jsonc:133-134`).
- **These count ATTEMPTS, not failures.** They are consumed at step 3, before the verify at step 5
  (`login.ts:318-330`), so a successful login spends a slot too. No binding can be made to count only
  failures, because the decision "is this key over threshold" must be made before the verify.
- The existing `SecurityCounterDO` is not a usable read path. It is an alerting aggregator: 33 fixed
  instances, 60-minute retention, salted truncated member hashes, reports to a ledger, **no read RPC**
  (`SecurityCounterDO.ts:1-13, 33-45`). For a known account its subject is the user id
  (`login.ts:329` passes `userId`), which would be an existence oracle if reused (§2).
- `UserSecurityDO` is per user (`getByName(userId)`, `login.ts:376`): it has no instance for a
  nonexistent account, so it cannot hold state keyed by an attempted email.

**Options.**

| | (a) soft limiter binding | (b) readable failure counter (KV, or DO shard) |
|---|---|---|
| Counts | attempts in a 60 s window, per location | exact failures, any window (e.g. 5 in 15 min) |
| New storage | none | KV key `lf:<HMAC(email)>` with TTL, or a DO shard |
| Privacy | same as today: the key embeds the email inside the binding for ≤ 60 s | key must be a keyed hash; entries exist for emails that are not accounts, so they need a TTL ≤ the window |
| Login-path cost | a local binding call, like the three existing ones | a KV read + write per attempt (eventually consistent, ~1 write/s/key), or a DO round trip |
| New failure mode | none | store unreachable: pick fail-open or fail-closed on every login |
| Slow-and-low (1 guess / 7 s) | not seen (stays inside any 60 s window) | seen |

**Recommend (a).** The state only ever *adds friction*, and friction tolerates an approximate counter;
a lockout would not (`ratelimit.ts:31-37`: a limiter key is a "ceiling-shaping tool, not a hard
guarantee"). It adds no store, no secret, no retention, no new failure mode on the path that every
login takes. The honest cost is the slow-and-low gap; the hard caps (10/60s per location per address)
already bound that case, and (b) is the follow-up if CireSnave wants a longer window. Not recommended
either way: Postgres (an auth-path write per attempt for strings that are not accounts is an unbounded
table and a DoS lever), or the alerting counter.

**Shape of (a).** Three soft keys consumed after the hard caps, mirroring them exactly. ⚠️ **Two
bindings, not one** (found while building it): a binding has ONE `limit`, and the thresholds differ
(3 and 15), which is exactly why `LOGIN_IP_LIMITER` is its own binding beside `LOGIN_LIMITER`. So
`LOGIN_CHALLENGE_LIMITER` (namespace 1017, 3/60s) carries `<ip>:<email>` and `email:<email>`, and
`LOGIN_CHALLENGE_IP_LIMITER` (namespace 1018, 15/60s) carries `ip:<limiterIpKey>`:

| soft key | mirrors | purpose |
|---|---|---|
| `ip:<limiterIpKey>` | hard (0) | one host spraying many addresses |
| `<ip>:<email>` | hard (a) | one host guessing at one address |
| `email:<email>` | hard (b) | a botnet guessing at one address |

"Challenge required" = any soft key denied. Keys use the **parsed, lowercased** email, never the raw
body (`login.ts:267-273`: the lookup is citext, a case-sensitive key multiplies the ceiling). An unknown
IP skips the `ip:` key and never pools into a shared bucket (`login.ts:238-244`, the same lock-everyone-out
reasoning).

## 2. No existence oracle

The trigger is a pure function of **(attempted email string, client IP, the three soft counters)**.

- It is evaluated at step 3, before `SELECT … FROM users` (`login.ts:310`). Nothing it reads, and nothing
  it writes, depends on whether a row exists.
- Both paths that currently reach `unauthorized()` do the same thing to the soft counters: they had
  already been consumed. We never "increment on wrong password only", which would be existence-neutral
  today only because `login.ts:324` and `:329` happen to share a function; consuming up front removes
  that coupling.
- The `CHALLENGE_REQUIRED` response (§6) is returned **before** the lookup and before the Argon2id
  verify. It is therefore identical for an existing and a nonexistent address. It is faster than a 401,
  but its latency is keyed on state that both kinds of address share, so it adds no account-state timing
  tell (the thing `login.ts:12-29` guards against: the barring refusal sits after the verify for that
  reason).
- A counter keyed on user id would be the oracle: a real account would accumulate state, a made-up address
  would not. The alerting counter has exactly this shape for a known account, which is why it is not
  reused.
- **Alerting must still see a challenged attacker.** A bot that never solves the challenge is rejected
  before the verify, so it would stop emitting `auth_failure`, and the `credential_stuffing` and
  per-IP signals would go quiet *because the defence worked*. The challenge rejection therefore emits one
  `auth_failure` event with `reason: "challenge_required"` and `counting: { email }`. That is the same
  counting shape as the no-such-user path (`login.ts:324`), so it too cannot discriminate.

## 3. No lockout by a victim's attacker

**Rule.** *The challenge state may be raised by anyone, for any address, and may only ever add one
requirement — a valid, single-use Turnstile token — to an attempt that is otherwise unchanged. It never
shrinks a budget, never extends a window, never refuses a request that carries a valid token and the
correct password, and it expires by itself within one limiter window.* Refusals remain exclusively the
three existing hard-cap 429s, with their existing numbers.

- An attacker hammering `victim@…` from many IPs puts the victim's next attempt in front of a widget.
  The victim solves it and signs in.
- Stated plainly, so it is not rediscovered later: the **existing** `email` hard cap already lets an
  attacker deny the victim for up to 60 s per location (`login.ts:246-253`, acknowledged in the
  `ORIGIN BEFORE THE LIMITER` note at `:44-56`). This design neither adds to nor removes it.
- Fail-closed on a siteverify outage (§5) is the only path where a challenged user is refused for a
  reason other than a hard cap. It is not attacker-inducible.

## 4. What the challenge does NOT do, and what it does

**Does not:** reset, extend, or bypass any hard cap. Order is fixed: hard caps → soft keys → token →
lookup. A request refused by a hard cap never reaches the token check, so a solved token cannot buy a
retry (`login.ts:287-306`); a request that passes the token check still consumed one slot in all three
hard buckets and will again on the next attempt. A solved challenge does not clear the soft state
either — the binding has no reset, and we must not simulate one.

**Does change:**

1. Past the soft threshold, a script that does not solve the challenge gets **zero guesses evaluated**
   per window instead of up to 10 per address per location. Each further guess costs a solve.
2. A solving farm sits behind the same hard caps. Its throughput is still ≤ 10 guesses/min/address/
   location, plus a per-token price it did not pay before.
3. A challenged attempt that is rejected costs us one binding call and no Argon2id (`login.ts:323,327`
   are the expensive lines), which makes the route cheaper to defend under flood.
4. Turnstile's own risk signal becomes an input to login for the first time.

Token binding: `data-action="login"` and an `action` check on the siteverify reply would stop a token
minted on the signup page being used here. A solving farm mints either, so the value is marginal and it
changes the shared `verifyTurnstile` signature used by three routes. **Not recommended**; listed so the
omission is deliberate.

## 5. siteverify unreachable

`verifyTurnstile` rejects on a network or non-JSON failure and resolves `false` on `success:false`
(`turnstile.ts:77-95`). The three existing callers treat both as a refusal (`signup.ts:177-188`).

- **Challenged attempt, siteverify throws** → `503 SERVICE_UNAVAILABLE` (an existing code,
  `errors.ts:82`), `console.error("turnstile verification errored", err)` as today, plus one
  `security: alerting_fault` line with `reason: "challenge_unavailable"` (greppable, and deliberately NOT an
  `auth_failure`, so a Cloudflare outage cannot feed `login_ip_burst`, `login_failure_storm` or
  `credential_stuffing`; `challenge_required` stays a counted `auth_failure`). The
  attempt is **not** evaluated against the password.
- **Challenged attempt, siteverify says `success:false`** → the same `CHALLENGE_REQUIRED` as a missing
  token (a re-challenge). The log keeps `error-codes` (`turnstile.ts:92`).
- **Unchallenged attempt** → siteverify is never called. An outage therefore changes nothing for a user
  below the threshold. A test asserts the call count is 0, with a positive control.
- Token length is bounded in the schema (≤ 2048, Cloudflare's documented maximum) so a caller cannot
  manufacture a throw with an oversized token.

## 6. UI

**Contract.** `LoginInput` gains an optional `turnstileToken` (`packages/shared/src/schemas.ts:61`,
today `{ email, password }`). New code `CHALLENGE_REQUIRED` in `ApiErrorCode` (`errors.ts:20`), HTTP 403
(the family `FORBIDDEN` already names: "origin/CSRF/Turnstile rejection", `errors.ts:36`). It is the one
deliberately **distinguishable** answer, which is safe because §2 makes it a function of (email, IP)
only. A request without the flag set is byte-identical to today.

**Page flow** (`apps/web/src/pages/login.astro`, SSR, `markPrivate`). The GET cannot know the state
without calling the api, and must not become a state probe, so:

1. The page renders as today: no widget, tight CSP (`setPublicPageCsp(Astro)`, `login.astro:25`).
2. On a POST answered `CHALLENGE_REQUIRED` (read with `apiErrorCode`, `api.ts:270`), the same response
   renders the widget. It calls `setPublicPageCsp(Astro, { turnstile: true })` again — the helper
   `set`s the header, so the second call wins (`csp.ts:135-139`). The cost is one rejected attempt.
3. The re-rendered form **prefills the email** (Astro escapes it; the page is already `markPrivate`)
   and never echoes the password. The password input gets `autofocus`.
4. The widget is the signup markup: `class="cf-turnstile"`, `data-response-field-name="turnstileToken"`,
   `data-error-callback`/`data-timeout-callback`, the `[data-turnstile-error]` retry note, and
   `initTurnstileErrorHandling()` (`signup.astro:151-200`, `scripts/turnstile-error.ts`). Dev/e2e keeps
   the visible `dummy-token` input behind `turnstileSiteKey ?` (`signup.astro:173-180`).
5. The `error` text is a new message ("Please complete the check below, then log in again.") in the
   existing `role="alert"` `<p id="error">` (`login.astro:90`). It is announced on load.

**Build guard.** `dummy-token` was documented as expected in exactly two chunks (signup,
forgot-password; `turnstile-build-guard.mjs:57-59`). The login page adds one more. The guard itself is a
scan of `dist/` for the literal and enumerates no chunk, so its code needed no change; its header comment
and `test/turnstile-build-guard.node.test.ts` were updated, and the property is kept: no `dummy-token`
under `dist/` in a build that has `PUBLIC_TURNSTILE_SITE_KEY` set. `assertTurnstileKeySetOnDeploy` needs
no change. (The "two chunks" count was already stale at the design's ref. Measured by a real `astro build` at the
implementing change, 2026-10-11: a key-less build has `dummy-token` in FIVE chunks, `dsa-notice`,
`forgot-password`, `login`, `resend` and `signup`; a build with `PUBLIC_TURNSTILE_SITE_KEY` set has it
in none, and the widget markup in the same five.)

**Accessibility.** Managed mode, no mode change and no `data-size`/`data-appearance` trick
(`turnstile-error.ts:14-19` forbids it). The widget is a labelled iframe operable by keyboard; the page
keeps its own `role="alert"` explanation and the retry control. Two things to verify at build rather
than assert here: that Cloudflare's widget meets WCAG 2.2 SC 3.3.8 for the challenge types it can
present, and that the retry control is reachable by keyboard in the re-rendered page. **There is no
non-Turnstile path:** password reset also requires a token (`forgot-password.ts:101-111`), so a user
who cannot use the widget has no self-service route. That is already true of signup; it is new for
login. Flagged for CireSnave and accepted (DECIDED 3, §9).

**Privacy policy.** Already covered in kind: `privacy-policy.md:20-21` ("bot detection (Cloudflare
Turnstile / WAF)"), `:44`, and `:61` (Cloudflare listed for "bot detection (Turnstile)"). The data is
the same: an IP and a token, sent to the same processor, for the same purpose. The soft limiter keys
embed the email for ≤ 60 s, exactly as the three existing keys do. **No change to the policy is
required.** Optional sentence, DRAFT for CireSnave, not applied here: *"When several sign-in attempts
fail in a short period, we ask you to complete a Cloudflare Turnstile check before the next one."*

## 7. Interaction with held #160, and merge order

- `login.ts` conflicts, both textual and trivial: #160 edits the header step list (`:30-35`), the
  imports (`:97-100`), deletes the `json()` helper (`:147-153`) and rewrites the tail (`:414-431` on #160's head).
  This design edits the same header list and import block and inserts at step 3/4 (`:306-308`). No
  semantic overlap: #160's `afterSignIn` runs only after a successful session mint, which a challenged
  or failed attempt never reaches.
- `login.astro`: #160 adds `deviceCookieFrom: Astro.request` to the apiFetch call (3 lines at `:47-51`).
  This design adds `turnstileToken` to the body next to it and an error branch below. Adjacent hunks.
- **Not done, deliberately:** using a *recognised device* (#160's cookie) to skip the challenge. It is a
  separate decision with its own forgery and shared-computer analysis and does not belong in this note.
- **Recommended order:** (1) this note, version 0.1.13; (2) #160 → 0.1.14; (3) #161 → 0.1.15, both held
  on CireSnave as today; (4) the implementation PR after #160, rebased on it, version allocated by the
  PM. The note touches no code, so it does not interact with the two holds beyond the version number.
- **Deploy order of the implementation.** It adds no migration, so nothing needs applying first. It
  adds one `ratelimits` binding. Web and api deploy in parallel (`docs/runbooks/deploy.md`). If the api
  ships first and returns `CHALLENGE_REQUIRED` to a web that does not understand it, the user sees
  "Invalid email or password" and can never proceed. So the api side is gated by an env flag
  (`LOGIN_CHALLENGE`, default off; off means the soft keys are not even consumed), and the flag is
  turned on only after the web side is confirmed live. Web-ahead-of-api is harmless.

## 8. Tests and mutants (to be written first, in the implementation PR)

API (`apps/api/test/login.test.ts` style; siteverify stubbed as `signup.test.ts:81` does, with a set of
used tokens so a replay answers `timeout-or-duplicate`):

| # | Test | Mutant it must kill |
|---|---|---|
| T1 | Attempts 1..N succeed or 401 as today; attempt N+1 inside the window is `CHALLENGE_REQUIRED`, N exactly | off-by-one in the soft threshold (`>` for `>=`) |
| T2 | Same token twice: second is refused | caching a verified token / skipping the duplicate check |
| T3 | A challenged attempt with a valid token and a **wrong password** still consumes all three hard buckets and emits `auth_failure invalid_credentials` | skipping the hard caps when a token is present |
| T4 | N valid-token attempts then one more inside the window → 429 `RATE_LIMITED` | moving the token check before the hard caps, or letting a solve clear state |
| T5 | Existing vs nonexistent address: the sequence of statuses + bodies for attempts 1..N+2 is identical, and the challenge appears at the same index | keying a soft bucket on `row.id`, or consuming only when `row !== null` |
| T6 | Flag off: every response and log line for the T1 sequence is byte-identical to main | any side effect of the new code when disabled |
| T7 | One failed attempt → the exact 401 of main; one successful attempt → the exact 200 of main | challenging below threshold |
| T8 | Challenged and unauthenticated: `withClient` and `verifyPassword` are never called | doing the lookup/verify before the token check |
| T9 | siteverify throws on a challenged attempt → 503, no password evaluation; throws while unchallenged → login unaffected, **call count 0** (control: count is 1 on a challenged attempt) | calling siteverify unconditionally |
| T10 | A challenge rejection emits one counted `auth_failure reason=challenge_required` with `{ email }` only | silent rejection blinding the alerting counters |
| T11 | An attacker's attempts from other IPs raise the challenge for the victim; the victim with a valid token and the right password gets 200 (hard cap untouched) | any code path that denies on challenge state |

Web: the GET has no Turnstile host in its CSP (the `csp.test.ts` pin that `login` stays tight); the
challenge render has the host, the widget, a prefilled escaped email and no password; the production-
shape build has no `dummy-token`; the `login.astro` source tests stay (`login-page.test.ts`: by-hand
302, forwarded Origin).

Controls: each mutant is checked to **apply** (assert the anchor matched once), and each "no X" assertion
is paired with the same assertion finding X in a positive case.

## 9. Decisions that were CireSnave's — DECIDED 2026-10-11

CireSnave, 2026-10-11, answering the four asks of the previous draft of this section, verbatim:
*"1) A 2) Fail closed 3) Accept 4) flag-gated so we have the option to turn it off in emergency situations."*

- **DECIDED 1 — soft thresholds: option A.** Per 60 s per location: `email` 3, `ip:email` 3, `ip` 15, so
  the 4th attempt on an address or the 16th from a host is challenged. (The alternative, 5/5/20, was
  not chosen.) The existing 30/10/10 hard caps are not touched. Built as `LOGIN_CHALLENGE_LIMITER`
  (3) and `LOGIN_CHALLENGE_IP_LIMITER` (15); see the note under §1.
- **DECIDED 2 — outage behaviour: fail closed** for the challenged attempt only: a 503
  `SERVICE_UNAVAILABLE`, the password is not evaluated, one `alerting_fault` line with reason
  `challenge_unavailable`, not counted as a login failure. (The alternative, falling back to the hard caps, was not chosen.)
- **DECIDED 3 — no non-widget path: accept.** A user who cannot operate the widget has no
  self-service route to log in or to reset a password. No support route was named.
- **DECIDED 4 — flag-gated, so the option to turn it off in an emergency exists.** The api var
  `LOGIN_CHALLENGE` (`"1"` is on, anything else off), shipped `"0"`. Off is today's route byte for byte,
  and switching it is an api-only change with no web deploy; the one-line procedure and the exact
  commands are in `docs/runbooks/deploy.md`, "The login challenge flag".

## 10. What an AI-generated suggestion got wrong or left out

CireSnave pasted an AI-generated suggestion on 2026-10-11 with three options. They are hypotheses, not
sources, and each is checked below against this repo at e3b6fb6 and against Cloudflare's own pages,
fetched 2026-10-11. **UNVERIFIED** marks what the fetched pages did not say.

| # | Option | What it assumes | What is wrong or missing against OUR code and the docs | What it would have cost |
|---|---|---|---|---|
| 1 | The backend counts failures (Redis or a database), sets a flag or cookie, and the frontend renders the widget | A cookie or flag can carry the "challenge required" state; failures are counted per username; a Redis exists | **The flag/cookie is client-controlled:** an attacker drops it and is never challenged. The trigger must be server state (this note, §1-2). **"Per username" is an existence oracle:** only a real account would accumulate state, and `login.ts:324` and `:329` are the two paths that must look the same; the key must be the *attempted* email string. **There is no Redis.** The alternatives, each with its own cost: a Durable Object per bucket is exact and strongly consistent but one instance per attempted string is unbounded for made-up addresses, which is why `SecurityCounterDO` uses 33 fixed instances (`SecurityCounterDO.ts:4-5`) and has no read RPC; Postgres through Hyperdrive means a `FRESH` read and write on every attempt, and an unbounded table of strings that are not accounts, a DoS lever on the one route that already spends Argon2id; KV is eventually consistent and has a minimum TTL (**UNVERIFIED: not fetched**). **Right:** verify Turnstile *before* the Argon2id work. The design does (T8, §8). | A bypass (cookie), an oracle (username key), or a new store with a new failure mode on every login. |
| 2 | An edge Worker in front calls the rate limiter before and after the origin | `limit()` can be read, then incremented only on a failure; the limiter is a precise global counter | **No peek.** The binding's documentation says "calls to limit() increment this" and documents no read-only method; our own header says the same (`ratelimit.ts:70`). A pre-check therefore counts every attempt, including good ones, and a second call after the origin counts a failure twice. **Not precise or global:** "permissive, eventually consistent, and intentionally designed to not be used as an accurate accounting system"; "for each unique key you pass … there is a unique limit per Cloudflare location". **Our topology differs:** there is no edge Worker in front; login is a server-side form POST through the web Worker over a service binding to the api (`login.astro:41`), and our field is `turnstileToken` set by `data-response-field-name` (`signup.astro:157`), not the documented default `cf-turnstile-response`. **Right:** the binding is the cheap local primitive, which is why §1 uses it, with the attempt-counting caveat stated. | A threshold effectively halved for every user, and a counter described as exact that is not. |
| 3 | A WAF rate-limiting rule that counts origin responses and issues a Managed Challenge | The zone's plan can count by response; a challenge interstitial can be answered on a POST response; the edge can own the decision | **(a) Plan:** a custom counting expression with "Response code, Response headers" is listed "No" for Free and Pro and "Yes" for Business and Enterprise; **this zone's plan is UNKNOWN to this repo.** Response fields are counted "after the response is sent", and "the rule filter expression cannot contain HTTP response fields". **(b) POST:** the pages fetched do not say whether a form POST can be solved and replayed (**UNVERIFIED**). The only related statement is that the challenge-page mechanism "fails when the browser expects a non-HTML response, such as an AJAX or XHR (fetch) request", with Turnstile Pre-clearance named as the alternative for APIs. **(c) Our verification and logging are bypassed:** the solve happens at the edge, so the api sees no token and no verdict, cannot emit the `security:` line or feed the alerting counters (§2), and cannot honour the fail-closed rule (§5). **(d) Keying:** characteristics on Free, Pro and Business are IP (Business adds NAT support); email-bearing ones (Form input value, JSON field, Body) are Enterprise only, so below Enterprise the rule can see an IP and not the attempted address, which misses the distributed-botnet case that `email:<email>` exists for (`login.ts:246-253`). Challenge actions on Free, Pro and Business "cannot select a duration". | A plan upgrade or an IP-only trigger, an unverified POST flow, and a defence that is invisible to our own alerting. |

**What this note keeps from them:** the instinct that Turnstile must be verified server-side on every
challenged request (Cloudflare: "You must call the Siteverify API to complete your Turnstile
implementation"; token "valid for 300 seconds" and "can only be validated once"; maximum length 2048,
which §5 bounds in the schema), and that the trigger belongs to the server.

**Sources fetched 2026-10-11:** Workers rate-limit binding, Turnstile server-side validation, WAF rate-limiting rules
and parameters, Cloudflare Challenges (challenge pages), all under developers.cloudflare.com. Quotations are
from the fetched text; re-read before relying on any of them.

## 11. Non-goals

No change to a hard cap. No lockout of any kind. No device-recognition input. No retention beyond the
binding's window. No change to signup, forgot-password or dsa-notice. No CAPTCHA other than Turnstile.
