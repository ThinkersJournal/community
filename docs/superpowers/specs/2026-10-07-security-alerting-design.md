# Security alerting and account-holder notices — Design (PR B)

**Status:** revision 5, for PM review. Docs only; no code in this PR.
**Ref:** file:line citations were read at `12d47c8` (PR A, #151, version 0.1.6). `origin/main` is now `f9bc131` (#152),
whose diff from `12d47c8` touches only `package.json` files and the lockfile, so no cited line has moved.
**Builds on:** PR A's `security:` log line, and the brute-force audit of 2026-10-06. That audit is a gitignored ledger
file, `.superpowers/sdd/alerts/audit.md`, not in the repo; the parts this spec relies on are quoted where used.
**Delivery:** waits on board 131, which has not chosen an alert transport. This spec specifies **the seam only** (§3).
**Revisions:** revision 1 answered the design audit of 4b6fadd; revision 2 the re-audit of d2f930c; revision 3 the
third audit of f943197; revision 4 the fourth audit of 42d3540; revision 5 the final audit of 75fbd2a (2 Important,
5 Minor). §9 maps every finding to its answer.

## 0. Rulings this design implements

- **CireSnave**, relayed by the PM, verbatim: *"Any potentially brute force findable secret should have countermeasures
  and likely alerting to a person in charge about any potential brute force discovery attempts."*
- **PM:** PR A shipped the countermeasures. PR B adds two things:
  - **(b)** failure counters, and alerts to `SECURITY_ALERT_EMAIL`;
  - **(c)** account-holder emails for a new sign-in and for a completed password reset.
- **PM:** *"design against SECURITY_ALERT_EMAIL plus a relay secret, with no vendor chosen"*. §7 lists the transport
  options for board 131 without choosing.
- **PM:** count by IPv6 /64 with `limiterIpKey`. The external uptime monitor is a line item, decided with the board 131
  transport (§7, D2).
- **PM, revision round 1:** no attacker-reachable signal may silence a *different* signal class (per-class budgets and
  cooldowns, summary classes, a "budget exhausted" alert, digests, a floor); suppressed counts persist until reported;
  after rollout the only silent path is the browser that completes signup (§2.6, §4.1).
- **PM, revision round 2:** floor subjects are reported uncapped, ranked by an uncapped count (N1); a daily heartbeat
  (N2); no counter-to-sink fallback (N3); cost with deletes (N4); versioned device keys, a missing key disables device
  notices (N5); a ref admin page with an audit row (N6); minimal ledger retention, purged on anonymisation (N7).
- **PM, revision round 3:**
  - **R1.** Held subjects are stored one row per subject, never one blob. Reports are built by paging in bounded
    chunks, in class-priority order (targeted accounts, then stuffing, then the rest), up to a fixed byte cap; past it,
    "N more in <class>" and a link to the admin page, which pages through the full list. Every subject stays
    retrievable until a delivered report has covered it. The heartbeat and the held-subject report don't depend on the
    digest: separate steps, each with its own error handling (§2.6).
  - **R2.** Liveness goes to KV as an ok timestamp; `/health/security-ledger` reads KV, answers only `ok` or `stale`,
    makes no DO call, and is edge-cached for 60 s (§2.6).
  - **R3.** The `moderation_actions` reader list comes from a grep, cited (§2.6).
  - **R4.** The audit row stores the opaque ref and the admin's identity, never the user id (§2.6, D5).
  - **R5.** §2.1 corrected; the migration number is allocated at implementation time and the migration is applied
    before the deploy, per the existing gate (§6).
  - **R6.** Reset bursts count per /48; counter tables are `WITHOUT ROWID`; cost recomputed (§2.4, §2.5).
  - **m-a to m-g:** fixed where they arise; the cron calls `ensureAlarm` for the heartbeat; `forgetAccount` leaves a
    tombstone with a TTL; the reaper subrequests are counted.
- **PM, revision round 4:**
  - **F1.** No site-wide notice limiter. A sign-in notice is never dropped: over the per-account cap, notices are
    coalesced into one deferred notice sent when the window reopens; a key-restore wave is spread with jitter. The
    invariant: every new-browser sign-in produces a notice to the account holder within a bounded delay (§4.4).
  - **F2.** The admin cursor sorts on the immutable key (class, subject_key); held rows carry a version from a
    per-ledger sequence, never a timestamp; delivery deletes only rows whose version is at or below the version the
    report covered; the coverage watermark is a sequence value (§2.6).
  - **F3.** Pruning loops until caught up or out of time and reschedules at once; held rows are capped per class;
    past the cap, subjects are counted, not stored, and that is reported and alerted. Past the cap, naming every
    subject gives way to counting them: decision D6 (§2.6, §7).
  - **F4.** IPv4 reset bursts count per /24; the cost is recomputed for both address families (§2.5).
- **PM, final round:** a deferred notice always reaches a named end state (G1); `pending_notice` stores everything
  the notice needs and its link comes from configuration, not a request (G2); the cron fallback is deleted (§4.4).

## 1. Signals

### 1.1 Every `security:` line on `main`

All of them go through one function, `logSecurityEvent` (`packages/shared/src/security-log.ts:33-45`). It writes
`console.warn("security: <kind> <route> <reason>", { kind, route, reason, ip, at })`. `kind` is `auth_failure` or
`rate_limited` (`:20`). It has five direct callers; the same grep (`logSecurityEvent(` in `apps/` and `packages/`,
tests excluded) finds all five and the definition, and nothing else.

| # | Source (file:line) | kind | route | reason / bucket | IP in the line |
|---|---|---|---|---|---|
| L1 | `apps/api/src/routes/login.ts:166` (`unauthorized`, called at `:322` no such user and `:327` wrong password) | auth_failure | `/auth/login` | `invalid_credentials`, the same for both cases | `clientIp()` |
| L2 | `apps/api/src/routes/reset-password.ts:87` (`invalidToken`, called at `:260` failed peek and `:275` lost redeem) | auth_failure | `/auth/reset-password` | `invalid_reset_token` | `clientIp()` |
| L3 | `apps/web/src/lib/purge.ts:134`, logged BEFORE the failure limiter is consulted | auth_failure | `/internal/purge` | `bad_purge_secret` | raw `CF-Connecting-IP`, may be null (`:132`) |
| L4 | `apps/web/src/lib/purge.ts:138`, in addition to L3 once over the limit | rate_limited | `/internal/purge` | `ip` (PURGE_LIMITER, `apps/web/wrangler.jsonc:216-222`) | as L3 |
| L5 | `apps/api/src/auth/ratelimit.ts:72` (`enforceRateLimit`), one line per refusal at each call site below | rate_limited | per call site | the bucket NAME, never the key (`:43-46`) | per call site |

`apps/web/wrangler.jsonc:204-210` says it outright: PURGE_LIMITER "does NOT bound the log volume … a flood logs two lines
per request". Every wrong-secret request is an L3; the limiter caps 403s, not failures. §2.2 accounts for that.

The `enforceRateLimit` call sites: 25 (24 in `apps/api/src/routes` plus `auth/pipeline.ts:344`), every hit for
`enforceRateLimit(` outside `ratelimit.ts`:

| Route | Bucket(s) | Limiter | file:line |
|---|---|---|---|
| `/auth/login` | `ip` (only when the IP is known), `ip:email`, `email` | LOGIN_IP_LIMITER 30/60s; LOGIN_LIMITER 10/60s | `routes/login.ts:280`, `:289`, `:297` |
| `/auth/reset-password` | `ip` (only when the IP is known) | RESET_REDEEM_LIMITER 10/60s | `routes/reset-password.ts:230` |
| `/auth/signup` | `ip:email`, `email` | SIGNUP_LIMITER 5/60s | `routes/signup.ts:159`, `:167` |
| `/auth/forgot-password` | `ip:email`, `email` | RESET_LIMITER 5/60s | `routes/forgot-password.ts:88`, `:94` |
| `/account/delete-request/resend` | `ip:email`, `email` | RESET_LIMITER | `routes/delete-request.ts:121`, `:126` |
| `/dsa-notice` | `ip:email`, `email` | DSA_LIMITER 5/60s | `routes/dsa-notice.ts:99`, `:105` |
| `/public/search` | `ip` (only when the IP is known, `search.ts:78`) | SEARCH_LIMITER 30/60s | `routes/search.ts:79` |
| `/public/profile` | `ip` (only when the IP is known) | PROFILE_LIMITER 60/60s | `routes/public.ts:171` |
| `/auth/resend-verification` | `user` | RESEND_LIMITER 3/60s | `routes/resend-verification.ts:54` |
| `/media` | `user` | MEDIA_LIMITER 20/60s | `routes/media.ts:117` |
| `/comments`, `/comments/:id` (×2) | `user` | COMMENT_LIMITER 10/60s | `routes/comments.ts:46`, `:178`, `:265` |
| `/reactions` (×2) | `user` | REACTION_LIMITER 60/60s | `routes/reactions.ts:46`, `:149` |
| `/follows` | `user` | FOLLOW_LIMITER 30/60s | `routes/follows.ts:32` |
| `/reports` | `user` | REPORT_LIMITER 20/60s | `routes/reports.ts:33` |
| `/blocks` | `user` | BLOCK_LIMITER 20/60s | `routes/blocks.ts:40` |
| (pipeline option) | caller-supplied | caller-supplied | `auth/pipeline.ts:343-353` |

The pipeline's `rateLimit` option (`auth/pipeline.ts:197`) has **0 callers**: a grep for `rateLimit\b` in `apps/api/src`
finds only its declaration and use in `pipeline.ts`, and a comment at `routes/media.ts:110`. Limits are from
`apps/api/wrangler.jsonc:132-271`, and every one is **per Cloudflare location** (`auth/ratelimit.ts:18-30`).

**Not `security:` lines, and out of scope:** a Turnstile failure logs `console.error("turnstile siteverify failed")`
(`auth/turnstile.ts:92`), and a held-media re-upload logs a moderator line (`routes/media.ts:216`). Neither uses the
prefix; adding them would change PR A's contract.

### 1.2 What the log line cannot carry, and why that decides the architecture

The log line has no email and no user id, on purpose (`security-log.ts:11-15`, `login.ts:160-163`). Two kinds of
signal need exactly that:
- **credential stuffing** = many *addresses* failing, from one /64 or across the site;
- **a targeted guess** = one *account* failing, often from many /64s.

A counter that reads the logs (Logpush, Workers Logs queries) cannot compute them without putting the address into
the logs, which PR A forbade. **So this design counts in-process, at the chokepoint that writes the line.**
`logSecurityEvent` gains a second, optional argument that goes to an observer and never to `console` (§2.2).

This departs from `security-log.ts:6-9`, which says the follow-up "counts these lines out of Cloudflare's Workers
Logs". The log line itself is unchanged, byte for byte. The implementation PR rewrites that comment, and
`login.ts:163`'s "the alerting follow-up counts by IP and route", to say what this spec does.

### 1.3 Which signals alert

Every signal belongs to one **class**. A class has its own budget and cooldown (§2.6), so no signal can spend another
class's alerts.

| Signal | Class | What it counts | Subject | Measure / window | Default threshold | Severity |
|---|---|---|---|---|---|---|
| `targeted_account` | account | L1 where the address is a real account | the account | events / 60 min | 30 | critical |
| `distributed_account_guess` | account | the same, distinct /64s | the account | distinct /64s / 60 min | 5 | critical |
| `credential_stuffing` | stuffing | L1, distinct addresses | the /64 | distinct addresses / 10 min | 10 | critical |
| `slow_stuffing` | stuffing | L1, distinct addresses | site | distinct addresses / 60 min | 150 | critical |
| `login_ip_burst` | ip_burst | every L1 (failed logins only, not 429s) | the /64 | events / 10 min | 50 | warning |
| `reset_token_burst` | ip_burst | L2 | the network: IPv6 /48, IPv4 /24 | events / 10 min | 20 | warning |
| `purge_secret_failure` | purge (summary) | every L3 | site | events / 10 min | 1 | critical |
| `login_failure_storm` | storm (summary) | L1 | site | events / 10 min | 300 | warning |
| `reset_token_storm` | storm (summary) | L2 | site | events / 60 min | 100 | warning |
| `rate_limit_storm` | storm (summary) | every L4 and L5 | site | events / 10 min | 500 | warning |
| `missing_client_ip` | infra | any event with `ip: null`, except purge | site | events / 10 min | 20 | warning |

Why each:
- **`targeted_account`, `distributed_account_guess`.** The per-email bucket allows 10/min per location
  (`login.ts:244-251`). 30 failures an hour against one real account, or failures from 5 different /64s, are not typing
  errors. They count only when the address is a real account (`row !== null`, `login.ts:317`); guessing at an address
  that doesn't exist harms nobody, and the stuffing signals still count it.
- **`credential_stuffing`.** The audit's first finding: "one IP gets a fresh 10/min allowance for every email address
  it tries". PR A bounded it with LOGIN_IP_LIMITER; nothing reports it. A household mistypes one or two addresses, not
  ten.
- **`slow_stuffing` (new, I9).** A residential-proxy pool can keep every /64 under 10 addresses in 10 minutes and the
  site under 300 failures in 10 minutes: that is about 43k attempts a day with no per-/64 or storm alert. Counting
  distinct failing addresses site-wide per hour catches it. 150 an hour is far above what typing errors produce on a
  site this size; D3 lets CireSnave tune it.
- **`login_ip_burst`.** LOGIN_IP_LIMITER allows 30/min per location (`login.ts:208-230`), so 50 in 10 min is a slow
  sustained guesser the limiter never stops. It counts failed logins only, after the limiter has let them through:
  a 429 goes to `rate_limit_storm` alone, so a 429 flood from rotating /64s writes no per-/64 rows (§2.5).
- **`reset_token_burst`.** A 256-bit token can't be guessed, so a burst means a broken client or someone probing the
  route PR A just hardened (`reset-password.ts:22-33`). It counts per network, an IPv6 /48 (the usual customer
  allocation) or an IPv4 /24: the signal is probing from one network, and a prober rotating addresses inside one
  network stays one subject (§2.5).
- **`purge_secret_failure`, threshold 1, as a summary.** The legitimate caller never fails: an authorized request never
  reaches the failure path (`purge.ts:107-118`). Any failure is an attack or a broken deploy (for example,
  `PURGE_SECRET` differing between the Workers). The first one each UTC day sends an onset alert; the rest of the day's
  activity rolls into the hourly digest (§2.6), so a curl loop can't produce one mail per request.
- **The storms.** The distributed case, which no per-/64 rule sees. They include the user-keyed 429s; the digest's
  per-route breakdown says which route stormed. Onset alert once per signal per day, then digest.
- **`missing_client_ip`.** In production every api request carries `X-TJ-Client-IP` from the web middleware
  (`apps/web/src/middleware.ts:21`, `lib/client-ip-store.ts:36-38`). A run of `null`s means that forwarding has
  regressed, and every IP-keyed limiter then degrades. Purge is excluded because a purge failure with no IP did not
  come through Cloudflare's public edge (`purge.ts:116-118`): it is a broken deploy, which `purge_secret_failure`
  already reports.

**Not alert-worthy on their own:** the user-keyed 429s. They need a session, so they're abuse by a known account (a
moderation matter), not secret discovery. They still count toward `rate_limit_storm`.

## 2. Counting

### 2.1 Where the counters live — options

| Option | Exact? | Global? | Distinct addresses / per account? | Cost and failure mode | Verdict |
|---|---|---|---|---|---|
| **Rate-limit bindings** | no ("not an accurate accounting system", `auth/ratelimit.ts:18-30`) | no, per location | no | **cannot be read without being spent** (`purge.ts:119-121`) | ruled out |
| **Workers KV** | no: no atomic increment; eventually consistent | yes, with propagation delay | only by writing the address into a key | concurrent increments lose updates | ruled out |
| **Postgres** (via Hyperdrive) | yes | yes | yes | a write per failure lands on the database the attack already loads; a migration, a reaper and a cron; **shares a failure mode with the app**, against the principle `apps/api/wrangler.jsonc:39-43` states for the HEALTH probe | rejected |
| **Workers Analytics Engine** | sampled at high volume (Cloudflare docs; not verified here) | yes | only by writing the address (or a hash) into a dataset | write-only from a Worker; reading needs the SQL API, an account API token and a cron poller | rejected for alerting; fine as a later dashboard |
| **Logpush / Workers Logs** | yes for what's in the log | yes | **no**: the line carries neither (§1.2) | an external consumer must count | rejected |
| **Durable Objects** (SQLite) | **yes**: single-threaded per instance, transactional storage | per instance | yes, salted and short-lived (§2.4) | bounded RPCs per isolate (§2.5); alarms for windowing, retention and retries; the storage class already runs `UserSecurityDO` (`apps/api/wrangler.jsonc:93-104`) | **chosen** |

**Choice: two new SQLite-backed Durable Object classes in the api Worker.**
- `SecurityCounterDO` counts. It has a **fixed set of 33 instances**: `ip:0`…`ip:15`, `acct:0`…`acct:15` and `site`.
  A subject is hashed to its shard, so /64 rotation adds rows, never instances (I4).
- `SecurityLedgerDO` decides. One instance, `ledger`, owns every cooldown, budget, held subject, report and outbox
  (§2.6). It receives only threshold crossings, never raw events, so a flood can't reach it at volume.

It is the only option that is exact, readable before deciding, able to hold the two signal kinds the log can't carry,
and independent of Postgres. `ratelimit.ts:35-36` already points to "a Durable Object … not this binding" for exact
accounting. **No counter data is kept in Postgres, and there is no Postgres reaper.** Postgres changes in one way
only: a migration adding the `security_ref_resolved` kind to `moderation_actions` (§2.6), applied before the deploy
(§6). Retention of everything else is enforced by DO alarms (§2.4, §2.6).

### 2.2 How events reach the counter

**1. `packages/shared/src/security-log.ts`** gains an observer hook and a counting-only argument. The log line is
unchanged.

```ts
/**
 * `alerting_fault` is the alerting pipeline reporting on itself (an unreachable
 * ledger, a missing key, §2.4 and §4.1), so a query for `security:` finds it.
 * The `security:` lines are therefore not all attacks: a query that counts
 * attacks filters on `auth_failure` and `rate_limited`. The observer may see an
 * `alerting_fault` (the missing-key line is logged inside a request's
 * `waitUntil`), but no rule matches it, and `missing_client_ip` excludes it.
 */
export type SecurityEventKind = "auth_failure" | "rate_limited" | "alerting_fault";

export interface SecurityEvent {
  kind: SecurityEventKind;
  /** The route path, e.g. `/auth/login`. */
  route: string;
  /** A short machine-readable cause, e.g. `invalid_credentials`, `ip`, `ip:email`. */
  reason: string;
  /** The client IP as the Worker resolved it, or null when it had none. */
  ip: string | null;
}

/**
 * What the COUNTER may know about an event that the LOG must never carry.
 * Handed to the observer only; never written to `console`.
 */
export interface SecurityEventCounting {
  /** The lowercased address a login attempt named (distinct-email counting). */
  readonly email?: string;
  /** The account the attempt resolved to, when one exists (per-account counting). */
  readonly userId?: string;
}

/** Called once per event, after the log line. Must not throw; a throw is swallowed. */
export type SecurityEventObserver = (event: SecurityEvent, at: Date, counting: SecurityEventCounting) => void;

let observer: SecurityEventObserver | null = null;

/** Installed once at module scope by a Worker's entry module; null uninstalls (tests). */
export function setSecurityEventObserver(next: SecurityEventObserver | null): void {
  observer = next;
}

/** Write one `security:` line, then tell the observer. Returns nothing and never throws. */
export function logSecurityEvent(event: SecurityEvent, counting: SecurityEventCounting = {}): void {
  const at = new Date();
  try {
    console.warn(`security: ${event.kind} ${event.route} ${event.reason}`, {
      kind: event.kind,
      route: event.route,
      reason: event.reason,
      ip: event.ip,
      at: at.toISOString(),
    });
  } catch {
    // A logging failure must never turn a refusal into a 500.
  }
  try {
    observer?.(event, at, counting);
  } catch {
    // Nor may a counting failure.
  }
}
```

**2. Callers.** Only login passes the second argument: `unauthorized(ip)` becomes `unauthorized(ip, counting)`; `:322`
passes `{ email }` (already lowercased by `LoginInput`, `login.ts:265-271`) and `:327` passes `{ email, userId: row.id }`.
Every other caller, including all 25 `enforceRateLimit` call sites, is unchanged. **On the api**, a future `security:`
line is counted automatically, because the observer sits inside `logSecurityEvent`. The web Worker installs no
observer; its one source (purge) passes events explicitly (item 4).

**3. The api's request scope, and the dispatcher pin (I1).** `apps/api/src/index.ts:17-22` says "THIS FILE ONLY
DISPATCHES. Do not add an `if` here", and `apps/api/test/route-protection.test.ts:159-216` pins its whole normalised
body as `EXPECTED_DISPATCHER_BODY`. So everything conditional lives in a new module, `apps/api/src/security/scope.ts`,
with its own tests, and `index.ts` changes in exactly the ways below. The implementer updates the snapshot with
exactly these changes, and the PR description shows the diff:

| Snapshot change | Why it is benign |
|---|---|
| `import { withSecurityScope } from "./security/scope";` | one import; its module-scope side effect is installing the observer, which writes nothing and dispatches nothing |
| `export { SecurityCounterDO } from "./durable-objects/SecurityCounterDO";` and `export { SecurityLedgerDO } from "./durable-objects/SecurityLedgerDO";` | DO classes must be exported from the entry module, exactly like the three already pinned (`:13-15`); they are not routes |
| `import { ensureLedgerAlarm } from "./security/ledger-cron";` and, inside the existing `*/2` branch, `ctx.waitUntil(ensureLedgerAlarm(env));` | one idempotent DO call that sets the ledger's alarm if none is set (§2.6, m-d); no route, no new branch |
| `return await match.route.handler(request, env, ctx, match.params);` becomes `return await withSecurityScope(env, ctx, () => match.route.handler(request, env, ctx, match.params));` | the same handler, called once, for the same matched route; no new `if`, no new path. `withSecurityScope` returns exactly what the handler returns (tested, §5) |

`scheduled` is not wrapped, so cron work logs but doesn't count. `nodejs_compat` is already on
(`apps/api/wrangler.jsonc:7`), and the web Worker already uses `AsyncLocalStorage` (`client-ip-store.ts:24`).

```ts
import { AsyncLocalStorage } from "node:async_hooks";

import { SecurityEventBuffer, setSecurityEventObserver } from "@thinkersjournal/shared";
import type { SecurityCounterRpc, SecurityRequestScope } from "@thinkersjournal/shared";

/** The env keys this module reads. `Env` satisfies it once the binding is added. */
export interface SecurityScopeEnv {
  /** `"off"` is the kill switch (§6). */
  readonly SECURITY_COUNTING?: string;
  readonly SECURITY_COUNTER: { getByName(name: string): SecurityCounterRpc };
}

/**
 * TEST SEAM (I5). The workerd pool cannot spy on an ES module's exports
 * (routes/reset-password.ts:94-99), so tests swap collaborators here instead.
 * Production never calls the setter.
 */
export interface SecurityScopeOverrides {
  readonly buffer?: SecurityEventBuffer;
  readonly stubFor?: (shard: string) => SecurityCounterRpc;
}

let overrides: SecurityScopeOverrides = {};

export function setSecurityScopeOverridesForTests(next: SecurityScopeOverrides | null): void {
  overrides = next ?? {};
}

const scopeStore = new AsyncLocalStorage<SecurityRequestScope>();
const defaultBuffer = new SecurityEventBuffer();

setSecurityEventObserver((event, at, counting) => {
  const scope = scopeStore.getStore();
  if (scope === undefined) return; // outside a request (cron): the log line only
  (overrides.buffer ?? defaultBuffer).add(event, at, counting, scope);
});

/**
 * Run one request's handler with counting enabled. src/index.ts's only change is
 * to call this around the handler it already dispatched (§2.2, the pin).
 * Returns exactly what `run` returns; counting can never change a response.
 */
export function withSecurityScope<T>(
  env: SecurityScopeEnv,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  run: () => Promise<T>,
): Promise<T> {
  if (env.SECURITY_COUNTING === "off") return run();
  const scope: SecurityRequestScope = {
    waitUntil: (p) => ctx.waitUntil(p),
    stubFor: overrides.stubFor ?? ((shard) => env.SECURITY_COUNTER.getByName(shard)),
  };
  return scopeStore.run(scope, run);
}
```

`Env` satisfies `SecurityScopeEnv` once `SECURITY_COUNTER` is bound. The assignability of the real
`DurableObjectNamespace<SecurityCounterDO>.getByName()` stub to `SecurityCounterRpc` was not checked here (no Workers
types in the scratch check, §8); the implementer's `pnpm typecheck` checks it.

**4. The web Worker (purge, L3/L4).** It has no Durable Objects today (0 hits for `durable_objects` in
`apps/web/wrangler.jsonc`; the same grep finds it at `apps/api/wrangler.jsonc:93`).
- It gets a cross-script binding: `{ "name": "SECURITY_COUNTER", "class_name": "SecurityCounterDO", "script_name":
  "thinkersjournal-api" }`. The implementer verifies `script_name` against the installed wrangler's config schema, as
  `ratelimits` was (`apps/api/wrangler.jsonc:118-125`), and that RPC to it works from the Astro Worker.
- `handlePurgeRequest` already takes its dependencies as parameters (`purge.ts:126-130`). It gains a fourth,
  `onSecurityEvent(event, at)`. The purge page implements it with a **module-scoped `SecurityEventBuffer`** (the same
  class as the api's, in `packages/shared`), passing a scope built from its own `waitUntil` and binding. **This
  corrects revision 0**, which made one RPC per failure on the false grounds that PURGE_LIMITER caps failures: it caps
  403s only (`apps/web/wrangler.jsonc:204-210`). A purge flood now costs at most one `site` RPC per web isolate per 5 s.
  With `SECURITY_COUNTING="off"` the page passes a no-op `onSecurityEvent` (§3.1).
- **Deploy order:** the api must deploy the classes before the web Worker can bind to them, the same kind of
  first-deploy ordering the purge hop already documents (`apps/api/wrangler.jsonc:112-116`).

### 2.3 Classification (pure, shared)

Rules are data. One event fans out to one increment per matching rule. `packages/shared/src/security-signals.ts`, so
the api and the web purge page classify identically:

```ts
import { limiterIpKey } from "./limiter-ip-key";
import type { SecurityAlertSignal, SignalClass } from "./security-alert";
import type { SecurityEvent, SecurityEventCounting } from "./security-log";

/**
 * What a rule's subject is: one /64 (`ip`; IPv4 whole), one network (`net`: an
 * IPv6 /48 or an IPv4 /24), one account, or the whole site. `ip` and `net`
 * subjects share the `ip:` shards.
 */
export type SubjectKind = "ip" | "net" | "account" | "site";

/** What a rule compares with its threshold. */
export type Measure = "events" | "distinct_email" | "distinct_ip";

export interface SignalRule {
  readonly signal: SecurityAlertSignal;
  readonly signalClass: SignalClass;
  readonly subject: SubjectKind;
  readonly measure: Measure;
  readonly windowMinutes: 10 | 60;
  readonly threshold: number;
  readonly severity: "warning" | "critical";
  readonly matches: (event: SecurityEvent, counting: SecurityEventCounting) => boolean;
}

const LOGIN = "/auth/login";
const RESET = "/auth/reset-password";
const PURGE = "/internal/purge";

const loginFailure = (e: SecurityEvent) => e.route === LOGIN && e.kind === "auth_failure";

/** §1.3's table, as code. Thresholds are open decision D3. Cooldowns and budgets are per class (§2.6). */
export const SIGNAL_RULES: readonly SignalRule[] = [
  // auth_failure only: a 429 is counted by the site storm rule alone, so a 429 flood from rotating /64s
  // writes no per-/64 rows (§2.5).
  { signal: "login_ip_burst", signalClass: "ip_burst", subject: "ip", measure: "events", windowMinutes: 10,
    threshold: 50, severity: "warning", matches: loginFailure },
  { signal: "credential_stuffing", signalClass: "stuffing", subject: "ip", measure: "distinct_email",
    windowMinutes: 10, threshold: 10, severity: "critical", matches: (e, c) => loginFailure(e) && c.email !== undefined },
  { signal: "slow_stuffing", signalClass: "stuffing", subject: "site", measure: "distinct_email",
    windowMinutes: 60, threshold: 150, severity: "critical", matches: (e, c) => loginFailure(e) && c.email !== undefined },
  { signal: "targeted_account", signalClass: "account", subject: "account", measure: "events", windowMinutes: 60,
    threshold: 30, severity: "critical", matches: (e, c) => loginFailure(e) && c.userId !== undefined },
  { signal: "distributed_account_guess", signalClass: "account", subject: "account", measure: "distinct_ip",
    windowMinutes: 60, threshold: 5, severity: "critical", matches: (e, c) => loginFailure(e) && c.userId !== undefined },
  { signal: "purge_secret_failure", signalClass: "purge", subject: "site", measure: "events", windowMinutes: 10,
    threshold: 1, severity: "critical", matches: (e) => e.route === PURGE && e.kind === "auth_failure" },
  // Per network (IPv6 /48, IPv4 /24): probing from one network writes one row per network per minute,
  // not one per request (§2.5).
  { signal: "reset_token_burst", signalClass: "ip_burst", subject: "net", measure: "events", windowMinutes: 10,
    threshold: 20, severity: "warning", matches: (e) => e.route === RESET && e.kind === "auth_failure" },
  { signal: "reset_token_storm", signalClass: "storm", subject: "site", measure: "events", windowMinutes: 60,
    threshold: 100, severity: "warning", matches: (e) => e.route === RESET && e.kind === "auth_failure" },
  { signal: "login_failure_storm", signalClass: "storm", subject: "site", measure: "events", windowMinutes: 10,
    threshold: 300, severity: "warning", matches: loginFailure },
  { signal: "rate_limit_storm", signalClass: "storm", subject: "site", measure: "events", windowMinutes: 10,
    threshold: 500, severity: "warning", matches: (e) => e.kind === "rate_limited" },
  { signal: "missing_client_ip", signalClass: "infra", subject: "site", measure: "events", windowMinutes: 10,
    threshold: 20, severity: "warning",
    matches: (e) => e.ip === null && e.route !== PURGE && e.kind !== "alerting_fault" },
];

/** Counter instances per subject kind. Fixed, so /64 rotation cannot create instances (§2.4). */
export const SHARDS_PER_KIND = 16;

/** One unit of work. `subject` is the /64 (or "none"), the user id, or "site". */
export interface CounterIncrement {
  readonly shard: string;
  readonly signal: SecurityAlertSignal;
  readonly subject: string;
  readonly route: string;
  /** Minutes since the epoch, UTC: the bucket. */
  readonly minute: number;
  readonly member: string | null;
}

/** FNV-1a, 32-bit. Load spreading only; not a security boundary. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The counter instance (`getByName` argument) that owns `subject`. */
export function shardFor(kind: SubjectKind, subject: string): string {
  if (kind === "site") return "site";
  return `${kind === "account" ? "acct" : "ip"}:${fnv1a(subject) % SHARDS_PER_KIND}`;
}

const IPV4_KEY = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * The network an address belongs to: an IPv6 /48 (from its canonical /64 key) or
 * an IPv4 /24 (IPv4-mapped IPv6 included, via limiterIpKey). Anything unparsed is
 * returned unchanged, so it never merges with another caller.
 */
export function networkKey(ip: string): string {
  const k = limiterIpKey(ip);
  if (k.endsWith("::/64")) return `${k.slice(0, -"::/64".length).split(":").slice(0, 3).join(":")}::/48`;
  const v4 = IPV4_KEY.exec(k);
  // Octets over 255 are not an address: returned unchanged, like any unparsed value.
  if (v4 !== null && v4.slice(1).every((o) => Number(o) <= 255)) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  return k;
}

function subjectFor(rule: SignalRule, event: SecurityEvent, counting: SecurityEventCounting): string | null {
  switch (rule.subject) {
    case "site":
      return "site";
    case "ip":
      // An IPv6 client counts on its /64 (limiterIpKey); IPv4 whole. No IP: subject "none".
      return event.ip === null ? "none" : limiterIpKey(event.ip);
    case "net":
      return event.ip === null ? "none" : networkKey(event.ip);
    case "account":
      return counting.userId ?? null;
  }
}

/** Every increment one event produces. Pure: the unit tests' main target. */
export function classify(event: SecurityEvent, at: Date, counting: SecurityEventCounting): CounterIncrement[] {
  const minute = Math.floor(at.getTime() / 60_000);
  const out: CounterIncrement[] = [];
  for (const rule of SIGNAL_RULES) {
    if (!rule.matches(event, counting)) continue;
    const subject = subjectFor(rule, event, counting);
    if (subject === null) continue;
    let member: string | null = null;
    if (rule.measure === "distinct_email") member = counting.email ?? null;
    if (rule.measure === "distinct_ip") member = event.ip === null ? "none" : limiterIpKey(event.ip);
    out.push({ shard: shardFor(rule.subject, subject), signal: rule.signal, subject, route: event.route, minute, member });
  }
  return out;
}
```

**/64 normalisation.** Every per-IP subject and every distinct-/64 member goes through `limiterIpKey`
(`packages/shared/src/limiter-ip-key.ts:24-36`). The log line keeps the full IP (`security-log.ts:39`), so the counter is
where the normalisation happens. Two addresses in one /64 are one subject; an IPv4-mapped address is its IPv4 address
(`:28-30`).

### 2.4 Inside `SecurityCounterDO`

- **Declaration.** `apps/api/src/durable-objects/SecurityCounterDO.ts`, exported from `src/index.ts` (§2.2 item 3),
  bound as `SECURITY_COUNTER`. Migration `{ "tag": "v4", "new_sqlite_classes": ["SecurityCounterDO",
  "SecurityLedgerDO"] }`, after `v3` (`apps/api/wrangler.jsonc:100-104`). Tables are created idempotently in the
  constructor inside `blockConcurrencyWhile`, like `UserSecurityDO` (`:30-41`).
- **RPC.** `record(batch: CounterBatch)`, and on `site` only, `summarise(fromMinute, toMinute)` for the ledger's digest.
- **Storage** (SQLite, per instance). Every table with a composite key is `WITHOUT ROWID`, so the primary key is the
  table and no separate index is written (R6; whether index writes are billed as rows is not stated on the pricing
  page, so this removes the question):

```sql
CREATE TABLE IF NOT EXISTS buckets (subject TEXT NOT NULL, minute INTEGER NOT NULL, route TEXT NOT NULL,
                                    counts TEXT NOT NULL,              -- JSON {signal: n}: ONE row per subject-minute-route
                                    PRIMARY KEY (subject, minute, route)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS members (signal TEXT NOT NULL, subject TEXT NOT NULL, minute INTEGER NOT NULL,
                                    member TEXT NOT NULL, PRIMARY KEY (signal, subject, minute, member)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY, report TEXT NOT NULL,
                                    attempts INTEGER NOT NULL DEFAULT 0, next_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS last_report (signal TEXT NOT NULL, subject TEXT NOT NULL, at_ms INTEGER NOT NULL,
                                        PRIMARY KEY (signal, subject)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS overflow (minute INTEGER PRIMARY KEY, n INTEGER NOT NULL);   -- `site` only
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;     -- the member salt
```

- **`record`, inside `ctx.storage.transactionSync` (synchronous; no `await`, no RPC inside it):**
  1. Upsert one `buckets` row per (subject, minute, route), adding the batch's counts into its JSON.
  2. Insert `members` for distinct measures. A member is stored as `hex(SHA-256(salt ‖ member))[0..32]`, where `salt`
     is 32 random bytes in `meta`. **The raw address is never stored**; it exists only in the RPC argument and in
     isolate memory for at most `FLUSH_DELAY_MS`. Two cost guards: `credential_stuffing` (the one ip-subject distinct
     rule) stores members only from the 3rd event of its subject in the window, so a /64 with one or two events writes
     no member row, and it crosses at 10 distinct addresses among events 3 onward (at least 12 events); and no rule
     stores more than 2 × its threshold members per window. The **event** count in `buckets` is never capped.
  3. For each touched (signal, subject), evaluate its rule over `minute > nowMinute − windowMinutes`.
  4. Over threshold: if `last_report` for that (signal, subject) is older than the rule's window, insert a report into
     `reports` (signal, class, subject, window, observed, uncapped `events`, by-route counts). A sustained attack on
     one subject therefore reports once per window, and keeps reporting while it stays over threshold, which keeps
     the ledger's uncapped count current (§2.6). **Bounded while the ledger is down (m4):** a report for a (signal,
     subject) that already has a pending report is merged into it (events added, window widened), and past 10,000
     pending rows a new subject's report is only counted in `meta` (`reports_overflow`); the next successful
     `report()` call carries that count, which the ledger adds to the class's `held_overflow`.

  After the transaction: `setAlarm(now)` if `reports` gained a row; otherwise make sure an alarm exists within
  10 minutes (`getAlarm()` first, since each `setAlarm` is billed as a row written).
- **`alarm()`, outside any transaction:**
  1. **Report** due rows to the ledger in one RPC, `ledger.report(reports)`, at most 500 rows per call. On success,
     delete them.
  2. **On failure: keep them, retry, and say so.** `attempts + 1`, `next_ms` backs off 1, 5, then every 15 minutes,
     indefinitely; a report is never dropped and never sent anywhere but the ledger. Each failed attempt writes one
     line, `logSecurityEvent({ kind: "alerting_fault", route: "security-ledger", reason: "ledger_unreachable", ip:
     null })`. The operator learns of the outage from the missing heartbeat or a `stale` health status (§2.6).
  3. **Prune** `buckets` and `members` older than 60 minutes, `last_report` older than 60 minutes, `overflow` older
     than 2 hours.
  4. If every table except `meta` is empty, `deleteAll()`. Pending reports keep an instance alive, so nothing
     reportable is ever lost by it.
- **Retention.** Counter rows ≤ 60 min; overflow ≤ 2 h; a pending report until the ledger has it.
- **Clock.** `record` and `alarm` delegate to internal methods that take `nowMs`; tests drive them through
  `runInDurableObject` with an explicit clock. Tests never sleep.

### 2.5 Batching, and what an attack costs us

```ts
import { classify } from "./security-signals";
import type { CounterIncrement } from "./security-signals";
import type { SecurityAlertSignal } from "./security-alert";
import type { SecurityEvent, SecurityEventCounting } from "./security-log";

/** One aggregated row: every increment with the same key, summed. */
export interface CounterRow {
  readonly signal: SecurityAlertSignal;
  readonly subject: string;
  readonly route: string;
  readonly minute: number;
  readonly n: number;
  /** Distinct members seen (raw; hashed by the counter, never stored raw). */
  readonly members: readonly string[];
}

/** What one `record` RPC carries to one counter instance. */
export interface CounterBatch {
  readonly rows: readonly CounterRow[];
  /** Only ever non-zero in the batch for `site`: increments dropped by the subject cap. */
  readonly overflowEvents: number;
}

/** The counter DO's RPC surface (`SecurityCounterDO`). */
export interface SecurityCounterRpc {
  record(batch: CounterBatch): Promise<void>;
}

/** What one request lends the buffer: its `waitUntil`, and a way to reach a counter instance. */
export interface SecurityRequestScope {
  waitUntil(promise: Promise<unknown>): void;
  stubFor(shard: string): SecurityCounterRpc;
}

/** One flush per isolate at most this often. */
export const FLUSH_DELAY_MS = 5_000;
/**
 * Distinct subjects per flush, per kind; increments for further subjects become
 * `overflowEvents`. Separate caps, so /64 rotation cannot crowd out accounts.
 */
export const MAX_SUBJECTS_PER_FLUSH = { ip: 50, acct: 200 } as const;
/** Distinct members kept per row: 2 × the largest distinct threshold (slow_stuffing, 150). */
export const MAX_MEMBERS_PER_ROW = 300;

interface MutableRow {
  readonly shard: string;
  readonly row: Omit<CounterRow, "n" | "members">;
  n: number;
  readonly members: Set<string>;
}

/**
 * Per-isolate aggregation. Volume costs memory only up to the caps above, and DO
 * calls only at flush time: at most one `record` per counter instance per flush,
 * and there are 16 + 16 + 1 instances (§2.4), so ≤ 33 RPCs per isolate per 5 s
 * however many events arrive and however many /64s they come from.
 */
export class SecurityEventBuffer {
  private rows = new Map<string, MutableRow>();
  private subjects = { ip: new Set<string>(), acct: new Set<string>() };
  private overflow = 0;
  private timerArmed = false;

  constructor(private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {}

  add(event: SecurityEvent, at: Date, counting: SecurityEventCounting, scope: SecurityRequestScope): void {
    for (const inc of classify(event, at, counting)) this.addOne(inc);
    if (!this.timerArmed) {
      this.timerArmed = true;
      // The flush runs inside THIS request's waitUntil, and creates its stubs there.
      scope.waitUntil(
        this.sleep(FLUSH_DELAY_MS).then(() => {
          this.timerArmed = false;
          return this.flush(scope);
        }),
      );
    }
  }

  private addOne(inc: CounterIncrement): void {
    if (inc.shard !== "site") {
      const kind = inc.shard.startsWith("ip:") ? "ip" : "acct";
      const seen = this.subjects[kind];
      if (!seen.has(inc.subject)) {
        if (seen.size >= MAX_SUBJECTS_PER_FLUSH[kind]) {
          this.overflow += 1;
          return;
        }
        seen.add(inc.subject);
      }
    }
    const key = `${inc.shard}|${inc.signal}|${inc.subject}|${inc.route}|${inc.minute}`;
    let row = this.rows.get(key);
    if (row === undefined) {
      row = {
        shard: inc.shard,
        row: { signal: inc.signal, subject: inc.subject, route: inc.route, minute: inc.minute },
        n: 0,
        members: new Set<string>(),
      };
      this.rows.set(key, row);
    }
    row.n += 1;
    if (inc.member !== null && row.members.size < MAX_MEMBERS_PER_ROW) row.members.add(inc.member);
  }

  /** Send everything waiting, one `record` call per counter instance. Never rejects. */
  async flush(scope: SecurityRequestScope): Promise<void> {
    const rows = this.rows;
    const overflowEvents = this.overflow;
    this.rows = new Map();
    this.subjects = { ip: new Set<string>(), acct: new Set<string>() };
    this.overflow = 0;
    const byShard = new Map<string, CounterRow[]>();
    for (const r of rows.values()) {
      const list = byShard.get(r.shard) ?? [];
      list.push({ ...r.row, n: r.n, members: [...r.members] });
      byShard.set(r.shard, list);
    }
    if (overflowEvents > 0 && !byShard.has("site")) byShard.set("site", []);
    const results = await Promise.allSettled(
      [...byShard].map(([shard, list]) =>
        scope.stubFor(shard).record({ rows: list, overflowEvents: shard === "site" ? overflowEvents : 0 }),
      ),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      // Counts only: a shard's rows carry IP prefixes and user ids.
      console.error("security-counter: record failed", { failed, of: results.length });
    }
  }
}
```

**Bounds, per request and per isolate:**
- A request that logs no `security:` line costs nothing.
- A request that logs one pays, on its response path, one `console.warn` (as today) and one synchronous `classify` plus
  a few map updates. **No DO call is ever made on a response path**; it rides a `waitUntil`.
- Per isolate: one flush per 5 s, one `record` RPC per instance touched, so **≤ 33 RPCs per isolate per 5 s**, however
  many events arrive and however many /64s they come from.
- Memory per isolate is bounded by the subject caps (50 ip subjects and 200 accounts per flush). Increments beyond them
  become `overflowEvents`, sent to `site` and reported in the digest. Site rows are uncapped, so overflowed traffic
  still counts toward the storm and slow-stuffing signals.
- **A 429 writes no per-subject row.** `rate_limited` events match only `rate_limit_storm`, a `site` rule whose rows
  aggregate per (route, minute) per flush (`login_ip_burst` counts failed logins only, §1.3).
- **A reset-token probe writes at least one row per network per minute, at most one per request:**
  `reset_token_burst` counts per IPv6 /48 or IPv4 /24 (`networkKey`). Rotating addresses inside one network costs us
  nothing extra; only the number of distinct networks does.
- **What an attacker controls:** how many isolates and locations its traffic lands on. The per-isolate bound does not
  cap the total; the cost to us scales with the attack.

**Worst case, priced (arithmetic on published prices, not a measurement).** Prices quoted 2026-10-07 from Cloudflare's
pricing pages. Durable Objects (Workers Paid): requests "1 million / month, + $0.15/million", which "Includes HTTP
requests, RPC sessions, WebSocket messages, and alarm invocations"; rows written "First 50 million / month included +
$1.00 / million rows"; "Deletes are counted as rows written"; "Each `setAlarm()` is billed as a single row written".
Workers Paid: requests "10 million included per month, +$0.30 per additional million"; CPU "30 million CPU
milliseconds included per month, +$0.02 per additional million CPU milliseconds". DO duration (GB-s) and Postgres
compute are not estimated.

Two attack shapes still write about one row per request. Both are priced below for 30 days at 100 requests a second
(259.2M requests).

**(A) Failed logins from fresh /64s and fresh addresses.** `login_ip_burst` writes its `buckets` row (shared with
`credential_stuffing`, which writes no member row before the 3rd event). The path pays a full Argon2id verify (~40–60
ms, `login.ts:78-79`) whether the address exists or not.

| Cost | Per event | Month |
|---|---|---|
| Workers requests | 1 | ≈ $75 |
| Workers CPU, 50 ms assumed (Argon2id) | 50 ms | ≈ $259 |
| DO rows written: one `ip:` `buckets` row written, then deleted by the prune (2 rows); `site` rows aggregate per flush; the `slow_stuffing` members stop at 300 per hour | ≈ 2 | ≈ $468 |
| DO requests: between 17 RPCs per isolate per 5 s (10 isolates ≈ 88M/month) and one per shard touched per event (ip and site: ≈ 518M/month) | ≤ 2 | ≈ $13 – $78 |
| Alarms, the cron's `ensureAlarm`, and the ledger | — | ≈ $1 |

Counting ≈ $480–$550 against a ≈ $334 baseline: **roughly 1.4 to 1.6 times.**

**(B) Failed reset-token redemptions spread over many networks.** The path runs one indexed SELECT and no Argon2id
(`reset-password.ts:258-261`), so its baseline is small: requests ≈ $75 plus CPU at ~2 ms ≈ $10 (Postgres compute not
estimated). Its counting cost depends on how many **distinct networks** the traffic comes from, the same way for both
address families, because a `buckets` row is per (network, minute):
- **6,000 or more networks** (IPv4 /24s or IPv6 /48s), each sending at most one request a minute: every request writes
  its own row, ≈ 2 rows per request with the prune, ≈ $468 in rows plus $13–$78 in requests. Counting ≈ $480–$550
  against ≈ $85: **roughly 5.7 to 6.5 times.** This is the worst case, and it is reachable by a large residential-proxy
  pool spread over 6,000 /24s or /48s.
- **Fewer networks, N of them:** ≈ 2 × N × 43,200 rows a month (one row per network per minute, plus its delete). For
  N = 600 that is ≈ 52M rows, ≈ $2 over the included 50M; for N = 100, ≈ 8.6M, inside the included amount. A pool of
  thousands of addresses concentrated in a few hundred /24s costs almost nothing to count.

So the /24 and /48 rules make the reset path's cost scale with network diversity instead of address count, but they do
not remove the worst case: **(B) at ≥ 6,000 networks is ≈ 5.7–6.5 times its own small baseline**, and (A) is ≈ 1.4–1.6
times a larger one. Both are arithmetic on the quoted prices, not measurements. Both are attacker-scaled; the levers are
the kill switch (`SECURITY_COUNTING="off"`, §3.1) and the D3 review before phase 2.

### 2.6 The ledger: classes, budgets, held subjects, heartbeat

`apps/api/src/durable-objects/SecurityLedgerDO.ts`, bound as `SECURITY_LEDGER`, one instance named `ledger`. It
receives only reports of crossed thresholds, never raw events, so a flood can't reach it at volume.

**The design rule (PM):** no attacker-reachable signal may silence a different signal class.

| Class | Signals | Mode | Cooldown | Daily budget (mails) | Floor |
|---|---|---|---|---|---|
| account | `targeted_account`, `distributed_account_guess` | subject | 6 h per (signal, account) | 12 | yes |
| stuffing | `credential_stuffing`, `slow_stuffing` | subject | 1 h per (signal, subject) | 12 | yes |
| ip_burst | `login_ip_burst`, `reset_token_burst` | subject | 1 h per (signal, subject) | 6 | no |
| infra | `missing_client_ip` | subject | 6 h | 2 | no |
| purge | `purge_secret_failure` | summary | onset once per UTC day | 1 | no |
| storm | `login_failure_storm`, `reset_token_storm`, `rate_limit_storm` | summary | onset once per signal per UTC day | 3 | no |

```ts
import type { HeldEntry, SecurityAlertSignal, SignalClass } from "./security-alert";

export interface ClassPolicy {
  /** `subject`: one alert per (signal, subject) per cooldown. `summary`: one onset alert per signal per UTC day, then the digest. */
  readonly mode: "subject" | "summary";
  /** Subject mode only. */
  readonly cooldownMinutes: number;
  /** Alerts per UTC day for this class alone. Nothing else can spend it. */
  readonly dailyBudget: number;
  /**
   * Floor classes: EVERY subject over threshold is named, in an alert or in the
   * next digest, ranked by its uncapped event count. The budget limits mails,
   * never which subjects are reported (§2.6).
   */
  readonly floor: boolean;
}

/** §2.6's table, as code. */
export const CLASS_POLICY: Readonly<Record<SignalClass, ClassPolicy>> = {
  account: { mode: "subject", cooldownMinutes: 360, dailyBudget: 12, floor: true },
  stuffing: { mode: "subject", cooldownMinutes: 60, dailyBudget: 12, floor: true },
  ip_burst: { mode: "subject", cooldownMinutes: 60, dailyBudget: 6, floor: false },
  infra: { mode: "subject", cooldownMinutes: 360, dailyBudget: 2, floor: false },
  purge: { mode: "summary", cooldownMinutes: 0, dailyBudget: 1, floor: false },
  storm: { mode: "summary", cooldownMinutes: 0, dailyBudget: 3, floor: false },
};

/** What the ledger knows when a crossing arrives. */
export interface LedgerState {
  readonly nowMs: number;
  /** Subject mode: this (signal, subject)'s cooldown end, or null. */
  readonly cooldownUntilMs: number | null;
  /** Summary mode: an onset alert for this signal was already sent this UTC day. */
  readonly onsetSentToday: boolean;
  /** Alerts this class has sent this UTC day. */
  readonly classSentToday: number;
  /** This class's budget_exhausted message was already queued this UTC day. */
  readonly exhaustedQueuedToday: boolean;
}

export type LedgerAction =
  | { readonly action: "send"; readonly cooldownUntilMs: number | null }
  | { readonly action: "summarise" }
  | { readonly action: "suppress_cooldown" }
  | { readonly action: "suppress_budget"; readonly queueExhausted: boolean };

/** The ledger's one decision, pure. Every non-send outcome is counted for the digest. */
export function decide(signalClass: SignalClass, s: LedgerState): LedgerAction {
  const p = CLASS_POLICY[signalClass];
  if (p.mode === "summary" && s.onsetSentToday) return { action: "summarise" };
  if (p.mode === "subject" && s.cooldownUntilMs !== null && s.cooldownUntilMs > s.nowMs) {
    return { action: "suppress_cooldown" };
  }
  if (s.classSentToday >= p.dailyBudget) {
    return { action: "suppress_budget", queueExhausted: !s.exhaustedQueuedToday };
  }
  return {
    action: "send",
    cooldownUntilMs: p.mode === "subject" ? s.nowMs + p.cooldownMinutes * 60_000 : null,
  };
}

/**
 * Stored `held` rows per class. Past the cap, a NEW subject is counted, not stored
 * (§2.6, D6), after first evicting the oldest already-covered row. Generous for
 * the floor classes. Summary classes hold nothing.
 */
export const HELD_ROW_CAP: Readonly<Record<SignalClass, number>> = {
  account: 20_000,
  stuffing: 20_000,
  ip_burst: 2_000,
  infra: 2_000,
  purge: 0,
  storm: 0,
};

/**
 * The most the ledger can send in one UTC day: every budget; one `budget_exhausted`
 * and one `held_capped` per SUBJECT-mode class (a summary class's budget is at
 * least its signal count, so `decide` returns `summarise` before it can be
 * refused; a test pins that); 24 digests; 24 held-subject reports; one heartbeat;
 * one `config_fault`; one `notice_dropped` per drop state.
 */
export function dailyMessageCeiling(): number {
  const classes = Object.values(CLASS_POLICY);
  const budgets = classes.reduce((sum, p) => sum + p.dailyBudget, 0);
  const subjectClasses = classes.filter((p) => p.mode === "subject").length;
  // + 2: one `notice_dropped` per drop state per day.
  return budgets + subjectClasses * 2 + 24 + 24 + 1 + 1 + 2;
}

/** The order a held-subject report names signals in: targeted accounts, then stuffing, then the rest. */
export const HELD_PRIORITY: readonly SecurityAlertSignal[] = [
  "targeted_account",
  "credential_stuffing",
  "slow_stuffing",
  "distributed_account_guess",
  "login_ip_burst",
  "reset_token_burst",
  "missing_client_ip",
];

/** Rows fetched per query while building a report: bounds memory per step. */
export const HELD_PAGE_SIZE = 200;
/** Bytes of entries per report: far under the 2 MB DO row limit and any mail transport's. */
export const HELD_REPORT_BYTE_CAP = 64 * 1024;

/**
 * Accumulates entries until the byte cap. The ledger pages `held` in
 * `HELD_PRIORITY` order, `HELD_PAGE_SIZE` rows a query, and stops paging at the
 * first `false`; everything after it becomes the report's `more` counts.
 */
export class HeldReportBuilder {
  private bytes = 0;
  private readonly list: HeldEntry[] = [];

  constructor(private readonly capBytes: number = HELD_REPORT_BYTE_CAP) {}

  tryAdd(entry: HeldEntry): boolean {
    const size = JSON.stringify(entry).length + 1;
    if (this.bytes + size > this.capBytes) return false;
    this.bytes += size;
    this.list.push(entry);
    return true;
  }

  get entries(): readonly HeldEntry[] {
    return this.list;
  }
}
```

**Budgets and classes.**
- A class's budget can be spent only by its own signals. The cheapest attacker-reachable inputs, a curl to
  `/internal/purge` or a 429 flood, are in summary classes, which send one onset alert per signal per day and then only
  feed the digest.
- **Exhaustion is never silent.** The first refusal of a subject-mode class's budget each UTC day queues one
  `budget_exhausted` message (class, budget, suppressed so far), exempt from every budget. A summary class can't be
  refused while its budget is at least its signal count (purge 1/1, storm 3/3); a test pins that invariant against
  D3 retuning (m-c).
- **What decoys cost an attacker (m-a).** Decoys no longer hide anything (every held subject is reported, below), but
  they are not free. A `targeted_account` decoy is a real account (signup costs a Turnstile solve under SIGNUP_LIMITER,
  `routes/signup.ts:159-171`) with 30 failed logins in an hour, each spending the per-address LOGIN_LIMITER budget of 10
  a minute per location (`login.ts:244-251`). A `distributed_account_guess` decoy is cheaper: one real account and
  failures from 5 different /64s. A `credential_stuffing` decoy /64 needs at least 12 failed logins against 10
  distinct addresses from events 3 onward (§2.4), within LOGIN_IP_LIMITER's 30 a minute (`login.ts:208-230`). Every
  decoy is reported, so it adds evidence rather than cover.

**Held subjects: one row each, versioned, capped, reported in bounded pages.**
- **Storage.** A crossing that `decide` doesn't send (cooldown or budget) upserts **one row per subject** in
  `held(signal_class, subject_key, signal, subject, events, suppressed, version, updated_ms) WITHOUT ROWID`, primary
  key `(signal_class, subject_key)` with `subject_key = signal ‖ "|" ‖ subject`, and a secondary index on
  `(signal_class, version)`. The upsert adds the report's uncapped `events`. Never a blob, never a list in one row.
- **Versions, not timestamps (F2).** The ledger keeps one monotonic sequence in `meta`. Every upsert sets the row's
  `version` to the next value. Versions order everything that matters below; `updated_ms` is used only to age covered
  rows out.
- **The held-subject report** is its own message (`held_report`) and its own alarm step, built every hour that
  something is open. It is built inside one `transactionSync`, so it reads one consistent state, at the sequence value
  `S` it reads first. "Open" means `version` greater than the class's coverage watermark `W` (below). `HeldReportBuilder`
  takes open rows in `HELD_PRIORITY` order (targeted accounts, then stuffing, then the rest), within a signal by
  uncapped `events`, most first, `HELD_PAGE_SIZE` (200) rows per query, and stops at `HELD_REPORT_BYTE_CAP` (64 KB) of
  entries. Past the cap it adds "N more in <class>" per class and `adminUrl`, the admin page's link. Work and memory
  per run are bounded by the cap and by the row caps below, and the stored message is far under the DO limits
  (Cloudflare's limits page, fetched 2026-10-07: "Maximum string, `BLOB` or table row size | 2 MB", "Maximum SQL
  statement length | 100 KB"). The outbox row carries `S` and each named row's key and version.
- **Delivery (F2).** When the report is delivered: each named row is deleted **only if its `version` ≤ the version the
  report named** (in statements of at most 100 keys), so a subject that crossed again after the snapshot survives,
  open, with its new events; and each class's watermark becomes `W = max(W, S)` (it never moves back, even if an
  older report is delivered after a newer one), which marks every row whose `version` ≤ `S`
  as **covered**: counted in the report's "N more". A covered row that crosses again gets a new version above `W`, so
  it is open again and will be named or counted again. A report that is never delivered changes nothing.
- **Covered rows stay retrievable** on the admin page until they age out (7 days after `updated_ms`) or are evicted by
  the row cap (below), whichever is first. Every held subject is therefore either named in a delivered report or
  counted in one with a link to its listing.
- **Row caps (F3).** `HELD_ROW_CAP` per class: 20,000 each for `account` and `stuffing`, 2,000 each for `ip_burst` and
  `infra`. A new subject arriving at a full class first evicts that class's oldest covered row (lowest `version` ≤ `W`).
  **If every stored row is still open, the new subject is counted, not stored**: `held_overflow(signal_class, day,
  counted)` is incremented, the first such count of the class each UTC day queues one `held_capped` message (exempt
  from budgets), and every digest and held-subject report carries the counts. Existing subjects keep updating in place.
  **This is the honest limit of the floor under a storage bound: past the cap, naming every subject gives way to
  counting them.** Reaching it takes 20,000 distinct open subjects in one floor class (for stuffing, at least 240,000
  failed logins from 20,000 /64s) before any report delivers. That trade is decision D6 (§7).
- **The bound.** At most 44,000 `held` rows (about 200 bytes each, ≈ 9 MB), against Cloudflare's 10 GB per-object
  storage.
- **Floor classes get no special treatment beyond the ordering and the larger caps**: their subjects are first in every
  report. The budget limits how many mails a class sends, never which subjects get reported.

**`report(reports)`, inside `transactionSync`:** for each report, skip it if the subject is an account with an
unexpired tombstone (below); otherwise `decide()`, then `send` → insert the alert into `outbox`, start the cooldown,
increment the class's daily count; `summarise` → add to the class's daily activity; `suppress_*` → upsert its `held`
row; `queueExhausted` → also insert the exhausted message. The cooldown starts when the alert is queued. **After the
transaction, `report()` always makes sure an alarm exists.**

**`alarm()`: independent steps.** Each step below is its own `try`/`catch` and, where it writes, its own transaction;
an exception is logged (`security: alerting_fault`, reason = the step) and the next step runs. So no step can stop
another, and in particular the heartbeat and the held-subject report never depend on the digest.
1. **Liveness first.** Write the current time to the HEALTH KV namespace under `security-ledger:ok`. So `ok` means
   "the ledger's alarm runs", not "messages are delivered": a sink that fails every time still reads `ok`, and only
   the missing heartbeat shows that.
2. **Deliver** due `outbox` rows (at most 20 per run) through `deliverSecurityAlert`. On `delivered: false`:
   `attempts + 1`, backoff 1, 5, 30 minutes. After 4 attempts the row is dropped, after writing the full message through
   `LogSecurityAlertSink` (each message is bounded and PII-minimal, §3.2), and `undeliverable + 1` for the next digest.
3. **Heartbeat.** The first alarm at or after 09:00 UTC each day queues one `heartbeat` (day, `lateMinutes`, per-class
   totals from `class_day` and counts over `held`, bounded by the row caps). Fixed size; nothing an attacker does
   changes it.
4. **Held-subject report**, as above, if anything is open and the hour has turned since the last one.
5. **Digest**, if the hour has turned and anything happened: per class, sent, suppressed by cooldown and by budget,
   open held subjects, summary-class activity from `site.summarise(…)` (an RPC, outside any transaction; on failure the
   digest says `siteSummaryUnavailable`), undeliverable and overflow counts. Counts only, so its size is fixed.
6. **Configuration.** With `ACCOUNT_NOTICES_ENABLED === "1"` and no `DEVICE_HASH_KEY`, queue one `config_fault` per UTC
   day (§4.1).
7. **Prune (F3)** in a loop: delete aged-out covered `held` rows, expired cooldowns, refs, tombstones and old
   `class_day` rows in chunks of 1,000, until nothing is left to prune or the step's time budget (2 s) is spent. If
   work remains, re-arm for **now**; otherwise re-arm for the next due outbox row or the next hour, whichever is
   sooner. Pruning can therefore never fall behind for long, and the row caps bound what it ever has to do.

**Keeping the alarm alive (m-d).** The api cron already runs every 2 minutes (`apps/api/wrangler.jsonc:292`). Its
`*/2` branch gains one line, `ctx.waitUntil(ensureLedgerAlarm(env))`, which calls the ledger's idempotent
`ensureAlarm()`: if no alarm is set, set one now. A ledger whose alarm stopped self-heals within 2 minutes. That is
about 21,600 DO requests a month. It adds one import and one line to the pinned dispatcher snapshot (§2.2).

**Mail ceiling:** `dailyMessageCeiling()` = 36 budgeted alerts + 4 `budget_exhausted` + 4 `held_capped` + 24 digests +
24 held-subject reports + 1 heartbeat + 1 `config_fault` + 2 `notice_dropped` = **96 a day**, every message bounded
in size.

**Health (R2).** `GET /health/security-ledger` on the api reads `security-ledger:ok` from the HEALTH KV namespace (the
namespace `/health/db`'s probe already uses, `apps/api/src/health/probe.ts:105`, `:123`; `apps/api/wrangler.jsonc:39-43`)
and answers `{ "status": "ok" }` (200) if the timestamp is under 2 hours old, else `{ "status": "stale" }` with
**503**, so a monitor sees a non-200, as `/health/db` does (`apps/web/src/pages/health/db.ts:19-20`). No timestamp, no
digest time, **no DO call**. The web Worker exposes it at the same path, the way `pages/health/db.ts` exposes
`/health/db`, but cached at the edge for 60 s: a new helper beside `markFeedCacheable` (`apps/web/src/lib/cache.ts:228`)
setting `maxAge: 60` with no stale-while-revalidate. One KV write per ledger alarm (at least hourly).

**Storage and retention, the shortest the reports need:**
- `held`: until named in a delivered report; once covered, until 7 days after `updated_ms` or eviction by the row cap.
  At most 44,000 rows.
- `held_overflow(signal_class, day, counted)`: today and yesterday.
- `meta`: the sequence, each class's watermark `W`, and the counters below.
- `cooldowns(signal, subject, until_ms) WITHOUT ROWID`: until `until_ms`, at most 6 h.
- `class_day(class, day, sent, onset_signals, exhausted_queued) WITHOUT ROWID`: today and yesterday.
- `outbox(id, message, attempts, next_ms)`: until delivered or dropped (about 36 minutes of retries at most).
- `account_refs(user_id PK, ref UNIQUE, last_used_ms) WITHOUT ROWID`: 7 days after the last message that named the
  account.
- `forgotten(user_id PK, until_ms) WITHOUT ROWID`: 30 days (m-e, below).
- `meta` also holds `undeliverable`, `config_fault_day`, `last_heartbeat_day`.

The ledger never calls `deleteAll()`.

**Anonymisation, idempotent against late reports (m-e).** The anonymise reaper calls `ledger.forgetAccount(userId)`
beside its `forgetDevices()` call (§4.5). It deletes that account's `account_refs`, `held` and `cooldowns` rows and
writes a **tombstone**, `forgotten(user_id, now + 30 days)`. `report()` skips any account-subject report whose user has
an unexpired tombstone, so a report that waited in a counter through a ledger outage can't re-create the rows. 30 days
outlasts any plausible outage; past it, the 7-day ref expiry is the backstop. Calling `forgetAccount` twice is
harmless. Counter rows expire within 60 minutes on their own.

**Account refs and the admin page.**
- **One ref per account:** a random 16-byte value, reused while the account keeps appearing, forgotten 7 days after
  its last appearance. An alert, digest or report never carries a user id.
- **The admin page,** `apps/web/src/pages/admin/security.astro`, behind Cloudflare Access like the other admin pages
  (`apps/web/src/pages/admin/`), calling the api through `adminApiFetch`, the way every admin page does (there is no
  generic admin proxy, `apps/web/src/lib/admin-api.ts`). It does two things: resolve a ref to its account, and page
  through the full held list (`adminUrl` links here), 200 rows a page. **The cursor is the immutable primary key**
  (F2): `GET /admin/security/held?class=<class>&after=<subject_key>` returns rows with `subject_key` greater than
  `after`, in key order, class by class in `HELD_PRIORITY` order; `events`, `version` and open/covered are shown as
  data, never used as the order. A row that changes between pages keeps its place, so nothing is skipped or listed
  twice. Two new api routes, `GET /admin/security/account-ref/:ref` and `GET /admin/security/held`, guarded by
  `requireAdmin`
  (`apps/api/src/admin/require-admin.ts`) and added to `ROUTES` beside the other `/admin/*` routes
  (`apps/api/src/routes.ts:394-413`), so route-protection inventories them. Unknown and expired refs answer the same
  404.
- **Audit row (R4).** Every successful resolution writes a row to the append-only `moderation_actions` table
  (`apps/api/migrations/0013_moderation_actions.sql:11`, append-only by trigger `:43-51`) through
  `recordModerationAction` (`apps/api/src/moderation/actions.ts:48`): `actorAdmin` = the admin's Access identity,
  `action` = `security_ref_resolved` (added to the TypeScript `ModerationActionKind` union too,
  `apps/api/src/moderation/actions.ts:14-26`), `internalNote` = the ref, `reason` = "Security alert reference looked up by an
  administrator". **No `subjectUserId`**: the row never names the user, and once the ref expires (7 days) nothing links
  the two. Paging the held list writes no row (it shows refs, not users).
- **The migration.** The new action kind re-states `moderation_actions_action_check`, whose latest list is
  `apps/api/migrations/0022_account_legal_holds.sql:69-79`. It is this design's only Postgres change (§2.1); its number
  and its place in the deploy are in §6.
- **The readers (R3).** `grep -rn "FROM moderation_actions\|JOIN moderation_actions" apps/api/src` at `12d47c8` finds
  17 matching lines in 16 statements (`moderation/appeals.ts:166-167` is one statement): `auth/account-status.ts:55`;
  `moderation/account-actions.ts:153`; `moderation/appeals.ts:39`, `:134`, `:166-167`, `:234`, `:341`;
  `moderation/author-hide.ts:49`; `moderation/auto-hide.ts:47`; `moderation/hidden-reason.ts:36`;
  `moderation/queue.ts:87`, `:93`, `:119`, `:130`; `routes/appeals.ts:147`; `routes/delete-request.ts:152`. The
  implementer re-runs the grep and confirms that each one either filters by action kind or by a subject the new row
  doesn't have. With no `subject_user_id`, no member-scoped read can return it; a test pins that (§5).

## 3. The seam

### 3.1 Secrets and vars (by key name only)

| Key | Kind | Worker | Purpose |
|---|---|---|---|
| `SECURITY_ALERT_EMAIL` | secret | api | Where alerts go. Never logged. |
| `SECURITY_ALERT_RELAY_TOKEN` | secret | api | The board-131 transport's credential. Never logged. |
| `DEVICE_HASH_KEY` | secret | api | The current HMAC key for device-list entries (§4.1). Missing or empty: device notices are **disabled**. |
| `DEVICE_HASH_KEY_PREV` | secret, optional | api | The previous key, set only during a rotation (§4.1). |
| `SECURITY_ALERTS_ENABLED` | var, `"0"`/`"1"` | api | `"1"` routes alerts to the transport; anything else uses the log sink. |
| `SECURITY_COUNTING` | var, default on | api, web | `"off"` skips counting: the kill switch. On the api, `withSecurityScope` checks it; on the web Worker, the purge page checks it and passes a no-op `onSecurityEvent`. |
| `ACCOUNT_NOTICES_ENABLED` | var, `"0"`/`"1"` | api | `"1"` mails the §4 notices; anything else logs that one would have been sent. |

- **Where the vars live:** in a new `vars` block in each `wrangler.jsonc`, reviewed like any config. Neither file has
  one today (0 hits for `"vars"`; the same grep shape finds `"ratelimits"` in both). Flipping one is a one-line config
  PR plus a deploy. A dashboard edit works as an emergency stop, but **the next `wrangler deploy` resets it** to the
  file's value; the runbook must say so.
- Secrets get hand-added lines in `apps/api/src/worker-configuration.d.ts`, the file's established pattern
  (`:20-25`, `:49-53`); the api's secrets are at `:43-53`. `SECURITY_ALERT_EMAIL` had 0 hits in the tree at `12d47c8`;
  the same grep finds `RESERVED_EMAIL_KEY`.

### 3.2 The interface and the payload

`packages/shared/src/security-alert.ts`:

```ts
/** Every signal this design counts. §1.3's table is the source of truth. */
export type SecurityAlertSignal =
  | "login_ip_burst"
  | "credential_stuffing"
  | "slow_stuffing"
  | "targeted_account"
  | "distributed_account_guess"
  | "purge_secret_failure"
  | "reset_token_burst"
  | "reset_token_storm"
  | "login_failure_storm"
  | "rate_limit_storm"
  | "missing_client_ip";

/**
 * Each class has its own budget and cooldowns, so no signal can spend another
 * class's alerts (§2.6, PM ruling on C1).
 */
export type SignalClass = "account" | "stuffing" | "ip_burst" | "purge" | "storm" | "infra";

/**
 * Who or what an alert is about. Never an email address, never a user id.
 * `ip_prefix` appears only on the ip-subject classes, where blocking the
 * prefix is the action (§3.2).
 */
export type SecurityAlertSubject =
  | { readonly kind: "ip_prefix"; readonly value: string }
  | { readonly kind: "no_ip" }
  | { readonly kind: "account"; readonly ref: string }
  | { readonly kind: "site" };

/** One threshold crossing that the ledger let through. */
export interface SecurityAlert {
  readonly type: "alert";
  readonly signal: SecurityAlertSignal;
  readonly signalClass: SignalClass;
  readonly severity: "warning" | "critical";
  readonly subject: SecurityAlertSubject;
  /** ISO-8601, the first minute bucket counted. */
  readonly windowStart: string;
  /** ISO-8601, when the threshold was crossed. */
  readonly windowEnd: string;
  /** Distinct members, or events, counted in the window (a distinct count is capped at 2 × threshold). */
  readonly observed: number;
  /** Events in the window, never capped: what floor-class ranking uses. */
  readonly events: number;
  readonly threshold: number;
  /** Event count per route in the window, e.g. `{ "/auth/login": 61 }`. */
  readonly byRoute: Readonly<Record<string, number>>;
  /** `CF_VERSION_METADATA.id` of the api Worker that raised it, or null. */
  readonly versionId: string | null;
}

/** Sent once per class per UTC day, the moment that class's budget refuses its first alert. */
export interface SecurityBudgetExhausted {
  readonly type: "budget_exhausted";
  readonly signalClass: SignalClass;
  readonly day: string;
  readonly budget: number;
  readonly suppressedSoFar: number;
}

/** Per class, for the digest: counts only, so the digest's size is fixed. */
export interface DigestClassLine {
  readonly signalClass: SignalClass;
  readonly sent: number;
  readonly suppressedByCooldown: number;
  readonly suppressedByBudget: number;
  /** Held subjects not yet covered by a delivered held-subject report. */
  readonly heldOpen: number;
  /** Summary classes: events and distinct /64s in the period, by signal. */
  readonly activity: Readonly<Record<string, { readonly events: number; readonly distinctPrefixes: number }>>;
}

/** Hourly while anything is unreported. Counts only; never a subject list. Exempt from every budget. */
export interface SecurityDigest {
  readonly type: "digest";
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly classes: readonly DigestClassLine[];
  /** Alerts the sink refused four times (§2.6), since the last digest. */
  readonly undeliverable: number;
  /** Increments a Worker folded into its overflow count instead of a per-subject counter (§2.4). */
  readonly overflowEvents: number;
  /** True when the site counter could not be read for `activity`. */
  readonly siteSummaryUnavailable: boolean;
}

/** One held subject, as a held-subject report names it. */
export interface HeldEntry {
  readonly signal: SecurityAlertSignal;
  readonly subject: SecurityAlertSubject;
  /** Uncapped events across every report while held: the ranking key. */
  readonly events: number;
  readonly suppressed: number;
}

/**
 * The held subjects, by name, up to a byte cap (§2.6). Its own message and its
 * own alarm step, so neither the digest nor the heartbeat depends on it.
 */
export interface SecurityHeldReport {
  readonly type: "held_report";
  readonly periodStart: string;
  readonly periodEnd: string;
  /** Class-priority order (`HELD_PRIORITY`), then uncapped events, most first. */
  readonly entries: readonly HeldEntry[];
  /** Past the cap: how many more per class, all listed on the admin page. */
  readonly more: readonly { readonly signalClass: SignalClass; readonly count: number }[];
  /** The admin page that pages through the full held list. */
  readonly adminUrl: string;
}

/**
 * Once per UTC day: the first ledger alarm at or after 09:00 sends it. Small and
 * fixed-size, its own alarm step, so silence means the pipeline is broken.
 */
export interface SecurityHeartbeat {
  readonly type: "heartbeat";
  readonly day: string;
  /** Minutes after 09:00 UTC that it went out; > 0 means the ledger's alarm ran late. */
  readonly lateMinutes: number;
  /** Today's totals so far, per class: alerts sent and subjects held. */
  readonly totals: readonly { readonly signalClass: SignalClass; readonly sent: number; readonly held: number }[];
}

/**
 * Sent once per class per UTC day, the moment that class's held-row cap first
 * makes the ledger COUNT a subject instead of storing it (§2.6). Exempt from budgets.
 */
export interface SecurityHeldCapped {
  readonly type: "held_capped";
  readonly signalClass: SignalClass;
  readonly day: string;
  readonly cap: number;
  /** Subjects counted, not stored, so far today. */
  readonly countedNotStored: number;
}

/**
 * A deferred account notice reached a drop state (§4.4): at most one per drop
 * state per UTC day, carrying how many notices ended that way so far today.
 * Never the account, the address or the user id. Exempt from budgets.
 */
export interface SecurityNoticeDropped {
  readonly type: "notice_dropped";
  readonly endState: "dropped_permanent_refusal" | "dropped_expired";
  readonly day: string;
  readonly countToday: number;
}

/** A configuration fault the operator must fix; at most one per key per UTC day. */
export interface SecurityConfigFault {
  readonly type: "config_fault";
  readonly key: "DEVICE_HASH_KEY";
  readonly detail: "missing";
}

export type SecurityAlertMessage =
  | SecurityAlert
  | SecurityBudgetExhausted
  | SecurityDigest
  | SecurityHeldReport
  | SecurityHeartbeat
  | SecurityHeldCapped
  | SecurityNoticeDropped
  | SecurityConfigFault;

export type SecurityAlertDelivery =
  | { readonly delivered: true }
  | { readonly delivered: false; readonly reason: string };

/**
 * THE SEAM. Board 131 supplies the real implementation; until then the log sink
 * runs. `send` must resolve, never reject; `deliverSecurityAlert` enforces that
 * for a sink that breaks the contract.
 */
export interface SecurityAlertSink {
  readonly name: string;
  send(message: SecurityAlertMessage): Promise<SecurityAlertDelivery>;
}

/** The pre-131 sink: one `security-alert:` line per message. Never the `security:` prefix. */
export class LogSecurityAlertSink implements SecurityAlertSink {
  readonly name = "log";

  async send(message: SecurityAlertMessage): Promise<SecurityAlertDelivery> {
    try {
      console.warn(`security-alert: ${message.type}`, message);
    } catch {
      // A log failure is not a delivery failure worth retrying.
    }
    return { delivered: true };
  }
}

/** The env keys the seam reads. Values are never logged. */
export interface SecurityAlertEnv {
  /** `"1"` routes alerts to the transport; anything else keeps the log sink. */
  readonly SECURITY_ALERTS_ENABLED?: string;
  /** Worker secret: where alerts go. */
  readonly SECURITY_ALERT_EMAIL?: string;
  /** Worker secret: the transport's credential (board 131). */
  readonly SECURITY_ALERT_RELAY_TOKEN?: string;
}

/** Builds the board-131 sink from env. `null` until that PR lands. */
export type SecurityAlertTransportFactory = (env: SecurityAlertEnv) => SecurityAlertSink;

/**
 * Pick the sink. Falls back to the log sink, LOUDLY, whenever the transport is
 * switched on but cannot run: an alert must never vanish because a secret is unset.
 */
export function selectSecurityAlertSink(
  env: SecurityAlertEnv,
  transport: SecurityAlertTransportFactory | null,
): SecurityAlertSink {
  if (env.SECURITY_ALERTS_ENABLED !== "1") return new LogSecurityAlertSink();
  const missing = [
    transport === null ? "transport" : null,
    (env.SECURITY_ALERT_EMAIL ?? "") === "" ? "SECURITY_ALERT_EMAIL" : null,
    (env.SECURITY_ALERT_RELAY_TOKEN ?? "") === "" ? "SECURITY_ALERT_RELAY_TOKEN" : null,
  ].filter((m): m is string => m !== null);
  if (transport === null || missing.length > 0) {
    console.error("security-alert: transport enabled but not configured; using the log sink", { missing });
    return new LogSecurityAlertSink();
  }
  return transport(env);
}

/** The only way anything calls a sink: bounded in time, and never throws. */
export async function deliverSecurityAlert(
  sink: SecurityAlertSink,
  message: SecurityAlertMessage,
  timeoutMs = 10_000,
): Promise<SecurityAlertDelivery> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SecurityAlertDelivery>((resolve) => {
    timer = setTimeout(() => resolve({ delivered: false, reason: "timeout" }), timeoutMs);
  });
  try {
    return await Promise.race([sink.send(message), timeout]);
  } catch (err) {
    return { delivered: false, reason: err instanceof Error ? err.name : "threw" };
  } finally {
    clearTimeout(timer);
  }
}
```

**Payload minimisation (I7).**
- **No user id, ever.** An account appears as an opaque ref an admin can resolve (§2.6).
- **An IP prefix only where it is the action.** `ip_prefix` appears only on the `stuffing` and `ip_burst` classes,
  whose subject is one /64 (or one IPv4 address). The response to such an alert is to block or challenge that prefix in
  Cloudflare's WAF, which needs the prefix; Workers Logs could supply it later, but log retention is limited and the
  operator may not have log access at that moment. Account alerts, site alerts and digests carry no IP, except the
  named /64 and /48 subjects in a held-subject report, for the same reason.
- **Never:** an email address, a limiter key (login's keys embed the address, `ratelimit.ts:43-46`), a password, a
  token, a secret, or a request body. The transport adds `SECURITY_ALERT_EMAIL` as the recipient; it is not part of
  any message.
- **The third-party disclosure.** Once board 131 picks a transport, these messages (prefixes, refs, counts) leave
  Cloudflare for that processor. That is a privacy-policy item (D5).

The log sink's prefix is `security-alert:`, not `security:`, so a query for `security:` events never counts alerts.

### 3.3 Where it is called and how failure is handled

- **The only caller of a sink is `SecurityLedgerDO.alarm()`.** Never a route and never a counter, so a sink can't block
  or fail an auth response, and every message passes through the ledger's ref minting.
- **The route's side:** `logSecurityEvent` (synchronous, never throws) → `buffer.add` (synchronous) →
  `ctx.waitUntil(flush)`. **The DO side:** `record` → `reports` → counter alarm → `ledger.report` → `outbox` → ledger
  alarm → `deliverSecurityAlert`.
- **Every failure has a defined effect:**
  - a failed `record` RPC: one count-only log line; those events are not counted;
  - an unreachable ledger: counters keep their reports, retry every 15 minutes, and log `security: alerting_fault`
    lines; the daily heartbeat is missing (§2.4, §2.6);
  - a sink that throws, hangs (10 s) or answers `delivered: false`: outbox backoff, then the log sink and an
    `undeliverable` count in the digest (§2.6);
  - a transport switched on but not configured: the log sink, plus a `missing` list of key names.
- `selectSecurityAlertSink(env, null)` is what ships now. Board 131 passes its factory instead of `null`, in one place.
- **Test seams:** `setSecurityScopeOverridesForTests` (buffer and stubs, §2.2), the buffer's injected `sleep`, and the
  ledger's `sinkFactory` field, which defaults to `selectSecurityAlertSink` and which tests replace on the instance via
  `runInDurableObject` (§5).

### 3.4 Can `postmarkSend` serve (b) and (c)?

`apps/api/src/auth/postmark.ts:34-80` sends through `POSTMARK_SERVER_TOKEN` (`:44`), never throws and returns `true`
only on a confirmed accept (`:6-8`), has a 10 s timeout (`:10-13`, `:42`), and never logs the recipient or body
(`:15-17`).
- **(c), account-holder notices: yes, today.** It is exactly what the reset mail uses: `sendPasswordResetEmail`
  (`auth/password-reset.ts:157-170`), stream `"outbound"`, the same no-reply sender address as the literal at `:163`,
  dispatched via `ctx.waitUntil` (`routes/forgot-password.ts:139`). This spec does not verify Postmark delivery end to
  end.
- **(b), operator alerts: it could, as one option for board 131, not a choice made here.** For: a sink wrapping
  `postmarkSend` is about 20 lines, needs no new vendor or relay token, and its never-throws contract matches the
  seam's. Against: it shares a failure mode with what it reports on. An attack that burns Postmark quota or reputation
  (signup and forgot-password both send mail) can stop the alert about that attack, and an outage silences alerts and
  user mail together, the shape `apps/api/wrangler.jsonc:39-43` warns against. A separate Postmark server, with its own
  token as `SECURITY_ALERT_RELAY_TOKEN`, removes the quota coupling but not the vendor coupling.

## 4. (c) Account-holder notices

### 4.1 When they fire

**A completed password reset.** After `redeem` commits (`reset-password.ts:272-277`), on both of its 200 paths,
including the barred account that gets no session (`:287-289`): its password did change. The audit found this missing
("A successful password reset sends no notice to the account holder").

**A new sign-in.** A successful `POST /auth/login` (a session minted at `login.ts:403`, after both bar checks at `:336`
and `:397`) from a browser whose device cookie is **not on this account's device list**. There is no exception for an
empty list (PM ruling on C3).

**The only silent path** is the browser that completes a signup: `recordDevice(hashes, now, "signup")` **clears** the
list and then records that browser. Consequences:
- **Rollout.** Every existing account starts with an empty list, so its first sign-in after rollout sends a notice. The
  copy says why ("the first sign-in after we began recording browsers").
- **Expiry.** An entry unseen for 400 days is pruned (by alarm, below). That browser's next sign-in is new and mails;
  so does a dormant account's first sign-in after its list empties. Dormant accounts are a classic stuffing target, so
  this is the case that most needs a notice.
- **Re-signup.** Re-signup of an unverified address keeps the user id (`routes/signup.ts:286-288`, `ON CONFLICT (email)
  DO UPDATE … WHERE users.email_verified_at IS NULL`, with `bumpEpoch()` at `:351-353`, which `:318` onward explains as
  half of the account-takeover fix). Its `"signup"` record clears the earlier claimant's browsers, so an attacker who
  registered the address first leaves no known device behind.
- **Reset.** `recordDevice(hashes, now, "reset")` clears every browser except the resetting one, then records it. The
  reset notice says so. An intruder's browser is no longer "known" after the owner recovers.
- **Barred reset (m4).** The barred path returns a bare 200 with no session (`reset-password.ts:279-289`). It mints **no
  device cookie** and records no browser; it calls `forgetDevices()`, so every browser is forgotten, and sends the reset
  notice. The response stays as that path defines it: status and body as on success, without cookies.
- **Anonymisation and the unverified reaper** clear the list (§4.5).

**The device cookie.** Production name `__Host-tj_device`: the `__Host-` prefix makes the browser insist on `Secure`,
`Path=/` and no `Domain`, so a page on a sibling subdomain cannot plant a value. Value: 32 CSPRNG bytes, base64url;
`HttpOnly; SameSite=Lax; Max-Age=34560000` (400 days). In dev/CI, where `Secure` can't be stored, the name is the
unprefixed `tj_device_dev`, gated on `TEST_ROUTES === "1"` exactly as the session cookie is (`auth/session.ts:86-101`).
Like `session.test.ts`, the tests pin both strings, since the suite runs with `TEST_ROUTES="1"`. `logout` and
`logout-all` don't clear it. The api mints it on any successful login, signup or (non-barred) reset response that
arrived without a well-formed one; the web Worker forwards the browser's whole `Cookie` header
(`apps/web/src/lib/api.ts:167-173`) and every api `Set-Cookie` (`:234-237`, `:288-291`).

**The device list.**
- Entries are `HMAC-SHA256(key, userId ‖ ":" ‖ token)`. Bound to the account: a browser shared by two accounts produces
  two unrelated values, so the list is not a cross-account identifier.
- Stored in `UserSecurityDO`, which login already calls (`login.ts:374`), in new tables created in its constructor
  (`UserSecurityDO.ts:30-41`), so no wrangler migration: `known_devices(device_hash PK, first_seen, last_seen)`,
  `notices(kind, sent_ms)`, `pending_notice(kind PK, count, first_event_ms, last_event_ms, last_country,
  list_was_empty, due_ms, attempts)` (§4.4); each entry also stores its key's `kid`.
- Capped at 20 entries (least recently seen evicted).
- **Retention is enforced by an alarm**, which `UserSecurityDO` gains (it has none today, `UserSecurityDO.ts:23-63`):
  after every write it arms itself for the earliest of (oldest `last_seen` + 400 days, oldest `sent_ms` + 24 h, the
  pending notice's `due_ms`), does what is due, and re-arms. The 400-day bound in the privacy policy is therefore true.
- `forgetDevices()` clears `known_devices` only; `security.epoch` and the notice tables are untouched (the barred
  reset path uses it and its own notice must still go out). `dropPendingNotices()` ends every pending notice as
  `dropped_account_gone`; only the reapers call it (§4.5).

**Versioned keys (N5).**
- **Matching.** `recordDevice` receives the browser's hash under `DEVICE_HASH_KEY` and, when `DEVICE_HASH_KEY_PREV` is
  set, under that key too. It matches either; a `prev` match is rewritten to the `current` hash in place. New entries
  are always written under the current key.
- **Rotation procedure.** (1) Put the old value in `DEVICE_HASH_KEY_PREV` and a new random value (32 bytes) in
  `DEVICE_HASH_KEY`; deploy. (2) Browsers that sign in are rewritten to the new key as they match. (3) After 90 days,
  delete `DEVICE_HASH_KEY_PREV`. A browser unused through the whole 90 days then counts as new at its next sign-in and
  mails, exactly as an expiry would; its stale entry is pruned at 400 days. Nothing else is affected, because no notice
  shows a count of entries.
- **Restoring a missing key.** Restoring the same value causes no wave: the entries recorded before it went missing
  still match. Browsers first seen while it was missing were never recorded, so their next sign-in mails, as it
  should.
- **Replacing the key without `_PREV`** makes every account's next sign-in "new": a wave. Each entry stores the id of
  the key that wrote it (`keyId`), so `recordDevice` can tell this case apart (`unknownKeysOnly`: the list is not
  empty, but no entry is under the current or previous key). Such a sign-in's notice is **spread, not dropped**: it
  is due at a uniformly random point in the next `WAVE_SPREAD_MS` (6 h), held as the account's pending notice (§4.4).
  The runbook says to rotate only with `_PREV` set.
- **A missing key disables device notices (fail quiet).** With no `DEVICE_HASH_KEY`, `resolveDeviceKeys` returns
  `null`: no browser is recorded and no sign-in notice is sent, so a bad deploy can't mail every user. Each sign-in that
  hits this logs `logSecurityEvent({ kind: "alerting_fault", route: "/auth/login", reason: "device_hash_key_missing",
  ip: null })`, and the ledger's alarm queues one `config_fault` message per UTC day while notices are enabled and the
  key is absent (§2.6). Reset notices don't depend on the key and still send. Phase 1b is gated on the key being set
  (§6).

```ts
export type AccountNoticeKind = "new_sign_in" | "password_reset";

/** Why a session is being minted; it decides what happens to the device list (§4.1). */
export type DeviceRecordMode = "signup" | "login" | "reset";

/**
 * The browser's entry under the current key, and under the previous key during a
 * rotation, each with its key id (`keyId`), stored beside the entry.
 */
export interface DeviceHashes {
  readonly current: string;
  readonly currentKid: string;
  readonly prev: string | null;
  readonly prevKid: string | null;
}

/** `UserSecurityDO.recordDevice`'s answer. */
export interface SignInRecord {
  /** The browser matched an entry under either key (a `prev` match is rewritten to `current`). */
  readonly knownDevice: boolean;
  /** The list was empty before the call (first sign-in since rollout, or every entry expired). */
  readonly listWasEmpty: boolean;
  /**
   * The list was NOT empty, but no entry was under the current or previous key:
   * the key was replaced without `_PREV`. Such a sign-in is part of a wave (§4.4).
   */
  readonly unknownKeysOnly: boolean;
}

/**
 * `UserSecurityDO.claimNotice`'s answer. A notice is never dropped: it is sent now,
 * or folded into the account's one pending notice of that kind, due `dueMs`.
 */
export type NoticeClaim =
  | {
      readonly send: "now";
      /** Earlier sign-ins folded into this notice, and when the first of them happened. */
      readonly coalesced: { readonly count: number; readonly sinceMs: number } | null;
    }
  | { readonly send: "deferred"; readonly dueMs: number };

/**
 * The methods this design adds to `UserSecurityDO`.
 * - `signup`: clear the list, then record this device. The ONE silent path.
 * - `reset`: clear every device except this one, then record it.
 * - `login`: record it; the caller notifies when it was not known.
 */
export interface UserSecurityNoticeRpc {
  recordDevice(hashes: DeviceHashes, nowMs: number, mode: DeviceRecordMode): Promise<SignInRecord>;
  /**
   * `notBeforeMs` > `nowMs` defers even an under-cap notice (the wave's jitter).
   * The event's country and `listWasEmpty` are stored if the notice is deferred.
   */
  claimNotice(
    kind: AccountNoticeKind,
    event: { readonly atMs: number; readonly country: string | null; readonly listWasEmpty: boolean },
    nowMs: number,
    notBeforeMs: number,
  ): Promise<NoticeClaim>;
  forgetDevices(): Promise<void>;
  /** Both reapers call this: every pending notice ends `dropped_account_gone`, logged. */
  dropPendingNotices(): Promise<void>;
}

export const NOTICE_CAPS: Readonly<Record<AccountNoticeKind, { readonly perHour: number; readonly perDay: number }>> = {
  new_sign_in: { perHour: 3, perDay: 10 },
  password_reset: { perHour: 3, perDay: 5 },
};

/**
 * The one pending notice per account and kind (`pending_notice` in
 * `UserSecurityDO`): everything the deferred notice needs, so the alarm builds
 * it with no request in hand (G2).
 */
export interface PendingNotice {
  readonly kind: AccountNoticeKind;
  /** Events folded in, including the latest. */
  readonly count: number;
  readonly firstEventMs: number;
  /** The latest event: the time and approximate country the notice reports. */
  readonly lastEventMs: number;
  readonly lastCountry: string | null;
  /** True if ANY folded sign-in found an empty list (sign-in notices only). */
  readonly listWasEmpty: boolean;
  readonly dueMs: number;
  /** Failed send attempts so far (transient refusals). */
  readonly attempts: number;
}

/** The pending notice's states. The last three are terminal; each drop is logged. */
export type NoticeState =
  | "pending" // folded, waiting for `dueMs`
  | "retrying" // a send was refused for a transient reason; backing off
  | "sent"
  | "dropped_account_gone" // anonymised, reaped, or no live row at send time
  | "dropped_permanent_refusal" // Postmark refused the recipient for good
  | "dropped_expired"; // transient refusals for NOTICE_MAX_AGE_MS

/** What `postmarkSend` saw, before it collapses to a boolean (§4.4). */
export type PostmarkOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number | null; readonly errorCode: number | null };

/**
 * Postmark's per-recipient refusals that no retry can fix: 300 (send validation,
 * e.g. an invalid address) and 406 (inactive recipient). Everything else (a
 * thrown request, a timeout, HTTP 429 or 5xx, and account-level codes such as
 * 10, 412 or 1480 that an operator must fix) is transient for this notice.
 */
export function classifyPostmark(o: PostmarkOutcome): "sent" | "permanent" | "transient" {
  if (o.ok) return "sent";
  return o.errorCode === 300 || o.errorCode === 406 ? "permanent" : "transient";
}

/** A notice still unsent this long after its first event is dropped (`dropped_expired`). */
export const NOTICE_MAX_AGE_MS = 7 * 86_400_000;

/** Retry delay after the n-th transient refusal (n ≥ 1): 15 min, doubling, at most 6 h. */
export function noticeRetryDelayMs(attempts: number): number {
  return Math.min(15 * 60_000 * 2 ** Math.max(0, attempts - 1), 6 * 3_600_000);
}

/**
 * Folding one more event into the pending notice (m2): the due time is the
 * EARLIER of the old one and this event's `notBeforeMs`, but never before the
 * cap reopens. Stable under repeated folds, so the 30 h bound holds.
 */
export function foldedDueMs(oldDueMs: number | null, notBeforeMs: number, capReopensAtMs: number): number {
  return Math.max(capReopensAtMs, oldDueMs === null ? notBeforeMs : Math.min(oldDueMs, notBeforeMs));
}

/** A device list entry unseen this long is pruned by `UserSecurityDO.alarm()`. */
export const DEVICE_TTL_MS = 400 * 86_400_000;

/** §4.1's definition of "new". No exception for an empty list (PM ruling on C3). */
export function isNewSignIn(r: SignInRecord): boolean {
  return !r.knownDevice;
}

/** The cap test `claimNotice` runs over the kind's send times (ms). */
export function capAllows(sentAtMs: readonly number[], nowMs: number, kind: AccountNoticeKind): boolean {
  const cap = NOTICE_CAPS[kind];
  const inLast = (ms: number) => sentAtMs.filter((t) => nowMs - t < ms).length;
  return inLast(3_600_000) < cap.perHour && inLast(86_400_000) < cap.perDay;
}

/**
 * When the cap next allows one more notice: the deferred notice's due time. At
 * most 24 h away, because every send time older than a day no longer counts.
 */
export function capReopensAt(sentAtMs: readonly number[], nowMs: number, kind: AccountNoticeKind): number {
  const cap = NOTICE_CAPS[kind];
  const reopen = (windowMs: number, limit: number): number => {
    const inWindow = sentAtMs.filter((t) => nowMs - t < windowMs).sort((a, b) => a - b);
    const mustExpire = inWindow.length - limit; // >= 0 means this window is full
    const t = inWindow[mustExpire];
    return mustExpire >= 0 && t !== undefined ? t + windowMs : nowMs;
  };
  return Math.max(nowMs, reopen(3_600_000, cap.perHour), reopen(86_400_000, cap.perDay));
}

/** A wave sign-in's notice is spread uniformly over this window, never dropped (§4.4). */
export const WAVE_SPREAD_MS = 6 * 3_600_000;

/** The earliest time this sign-in's notice may go out: now, or a random point in the wave window. */
export function noticeNotBefore(r: SignInRecord, nowMs: number, random: () => number): number {
  return r.unknownKeysOnly ? nowMs + Math.floor(random() * WAVE_SPREAD_MS) : nowMs;
}

/**
 * THE INVARIANT (§4.4): every new-browser sign-in with notices enabled and a key
 * set produces a notice within this long, plus however long Postmark refuses.
 */
export const NOTICE_MAX_DELAY_MS = WAVE_SPREAD_MS + 24 * 3_600_000;

/** Production cookie: `__Host-` forces Secure, Path=/ and no Domain, so a sibling subdomain cannot plant it. */
export const DEVICE_COOKIE = "__Host-tj_device";
/** Dev/CI only (`TEST_ROUTES === "1"`), where Secure cannot be stored; same gate as the session cookie. */
export const DEV_DEVICE_COOKIE = "tj_device_dev";

export function buildDeviceCookie(env: { readonly TEST_ROUTES?: string }, token: string): string {
  if (env.TEST_ROUTES === "1") {
    return `${DEV_DEVICE_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000`;
  }
  return `${DEVICE_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=34560000`;
}

/** The device keys, or null when device notices must be DISABLED (no current key). */
export interface DeviceKeys {
  readonly current: string;
  readonly prev: string | null;
}

export function resolveDeviceKeys(env: {
  readonly DEVICE_HASH_KEY?: string;
  readonly DEVICE_HASH_KEY_PREV?: string;
}): DeviceKeys | null {
  const current = env.DEVICE_HASH_KEY ?? "";
  if (current === "") return null;
  const prev = env.DEVICE_HASH_KEY_PREV ?? "";
  return { current, prev: prev === "" ? null : prev };
}

/**
 * The stored identifier: HMAC-SHA256 keyed by a device key over the user id and
 * the token. Bound to the account, so one browser shared by two accounts yields
 * two unrelated values.
 */
export async function deviceHash(key: string, userId: string, token: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(`${userId}:${token}`)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A short, non-secret id for a key, stored beside each entry so a replaced key is detectable. */
export async function keyId(key: string): Promise<string> {
  return (await deviceHash(key, "key-id", "")).slice(0, 8);
}

export async function deviceHashes(keys: DeviceKeys, userId: string, token: string): Promise<DeviceHashes> {
  return {
    current: await deviceHash(keys.current, userId, token),
    currentKid: await keyId(keys.current),
    prev: keys.prev === null ? null : await deviceHash(keys.prev, userId, token),
    prevKid: keys.prev === null ? null : await keyId(keys.prev),
  };
}
```

**The flow on login** (after the response is built, in one `ctx.waitUntil`):
1. `keys = resolveDeviceKeys(env)`; if `null`, log the fault and stop (no recording, no notice).
2. `recordDevice(await deviceHashes(keys, userId, token), now, "login")`.
3. If `isNewSignIn` and `ACCOUNT_NOTICES_ENABLED === "1"`: `claimNotice("new_sign_in", { atMs: now,
   country, listWasEmpty: record.listWasEmpty }, now, noticeNotBefore(record, now, Math.random))`. On `send: "now"`, `SELECT email FROM users WHERE id = $1 AND
   anonymised_at IS NULL` on `HYPERDRIVE_FRESH` and, if a row, `postmarkSend` on the `"outbound"` stream, with any
   `coalesced` count in the copy. On `send: "deferred"`, nothing more here: `UserSecurityDO`'s alarm sends it (§4.4).
   There is no site-wide limiter anywhere in this flow.
4. With the flag off, step 3 instead logs `account-notice: would_send new_sign_in` (no id, no address) and claims
   nothing.

**Reset** is the same with mode `"reset"` and `claimNotice("password_reset", { atMs: now, country, listWasEmpty: false }, now, now)`, for `redeemed.userId`; with no key
it skips the device steps but still sends the reset notice.

On the response path login gains only a cookie read, and a second `Set-Cookie` when it mints one. The notice work
never runs on a failed login.

**What is still not covered (the honest mitigation).**
- **A stolen browser or cookie jar.** Someone holding both the password and a known device cookie signs in silently.
  The notice detects a new browser, not a new person.
- **A compromised mailbox.** Whoever can read the mailbox can redeem a reset link, and the reset notice reaches them
  too. Its copy tells the owner to secure the mailbox first.
- **The flag, the key and the caps.** With `ACCOUNT_NOTICES_ENABLED` off, or no `DEVICE_HASH_KEY`, no sign-in notice
  is mailed. Over the per-account caps (§4.4) notices are coalesced and deferred, never dropped: at most 30 h late.
- **Revision 1's "N other browsers on record" line is removed (m3).** Private windows and cleared cookies each add an
  entry, so the number was noise, and its "reset if you don't recognise it" advice would have sent owners chasing it.

### 4.2 What they say

The time in UTC; the **country only**, approximately, when the edge supplies one; **never the IP**, and no city. An IP
means nothing to most holders and puts a security-log value into a mailbox we don't control; a country is enough to
answer "was that me?". The api sees requests over the Service Binding, not from the edge, so the web middleware
forwards the edge's country as `X-TJ-Client-Country`, with the same delete-then-set discipline as the IP
(`client-ip-store.ts:59-63`) and the same enumeration test of every `API.fetch` call site
(`web/test/client-ip-store.test.ts`). The implementer verifies which of `request.cf?.country` or the `CF-IPCountry`
header reaches `middleware.ts` under the Astro adapter, and that `Intl.DisplayNames` works in workerd (the code falls
back to the bare code if it throws). A value not matching `^[A-Z]{2}$` omits the phrase.

```ts
export interface NoticeInput {
  readonly at: Date;
  /** ISO 3166-1 alpha-2 from the edge, or null. Never an IP. */
  readonly country: string | null;
  /** Earlier events of this kind folded into this notice by the cap, or null. */
  readonly coalesced: { readonly count: number; readonly since: Date } | null;
  /** `${CANONICAL_ORIGIN}/forgot-password` (`auth/email-verify.ts:38`): never derived from a request. */
  readonly forgotPasswordUrl: string;
}

export interface SignInNoticeInput extends NoticeInput {
  readonly listWasEmpty: boolean;
}

export interface NoticeText {
  readonly subject: string;
  readonly textBody: string;
}

function where(country: string | null): string {
  if (country === null || !/^[A-Z]{2}$/.test(country)) return "";
  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(country);
    return ` from ${name ?? country} (approximate)`;
  } catch {
    return ` from ${country} (approximate)`;
  }
}

function more(c: NoticeInput["coalesced"], one: string, many: string): string {
  if (c === null || c.count <= 0) return "";
  return `\n\nThis notice also covers ${c.count} other ${c.count === 1 ? one : many} since ` +
    `${c.since.toISOString()} (UTC), held back so this account is not sent a flood of mail.`;
}

function firstSince(i: SignInNoticeInput): string {
  return i.listWasEmpty
    ? `\n\nThis account had no browser on record. That happens on the first sign-in after we began ` +
      `recording browsers, or after the last one went unused for 400 days.`
    : "";
}

export function newSignInNotice(i: SignInNoticeInput): NoticeText {
  return {
    subject: "New sign-in to your Thinkers Journal account",
    textBody:
      `Your Thinkers Journal account was signed in to at ${i.at.toISOString()} (UTC)${where(i.country)}, ` +
      `on a browser it has not been signed in to before.` +
      firstSince(i) +
      more(i.coalesced, "new sign-in", "new sign-ins") +
      `\n\nIf this was you, you can ignore this email.` +
      `\n\nIf it was NOT you, reset your password now: ${i.forgotPasswordUrl}\n` +
      `A reset signs out every other device, including the one that just signed in.`,
  };
}

export function passwordResetNotice(i: NoticeInput): NoticeText {
  return {
    subject: "Your Thinkers Journal password was changed",
    textBody:
      `The password for your Thinkers Journal account was changed at ${i.at.toISOString()} (UTC)` +
      `${where(i.country)}, using a reset link sent to this address. Every other device was signed out, ` +
      `and every other browser was removed from the account's record.` +
      more(i.coalesced, "password change", "password changes") +
      `\n\nIf this was you, you can ignore this email.` +
      `\n\nIf it was NOT you, someone may have access to this mailbox. Secure your email account first, ` +
      `then reset your password again: ${i.forgotPasswordUrl}`,
  };
}
```

The HTML body is the same text, escaped, with the link as an anchor, following `sendPasswordResetEmail`'s `htmlBody`
(`auth/password-reset.ts:167`). The link origin is the configured `CANONICAL_ORIGIN` (`auth/email-verify.ts:38`), for immediate and
deferred notices alike, never a request header. It is a constant rather than an env var: the api's only origin var
is `PREVIEW_ORIGIN` (`auth/csrf.ts:86-87`), which widens the CSRF allowlist and must not steer mail. In production
`verificationLinkOrigin(request)` (`:86`) returns the same value, since its allowlist holds only that origin (`:59-61`).

### 4.3 What the holder can do: "wasn't me"

The link is the existing `/forgot-password` page (`apps/web/src/pages/forgot-password.astro`), with no token and no
prefilled address. That is enough: a completed reset bumps the security epoch inside its transaction
(`reset-password.ts:191`), which revokes every other session, and now also clears every other browser from the list.
A one-click "secure my account" token was rejected: it would be a new bearer-token endpoint, one more
brute-force-findable secret, needing its own limiter, expiry and alerting. The Turnstile-protected form
(`forgot-password.ts:101-112`) costs the owner seconds.

### 4.4 Rate-limiting the notices, without ever dropping one

**The invariant (F1).** With notices enabled and a device key set, **every new-browser sign-in produces a notice to the
account holder within `NOTICE_MAX_DELAY_MS` (30 h)**, or else reaches a named drop state that is logged and, where
Postmark is the cause, alerted (below). Only the cases §4.1 names produce no sign-in notice at all: the signup
browser, notices switched off, a missing key, and accounts that no longer exist. Nothing site-wide can delay or suppress one account's notice: revision 3's site-wide
`NOTICE_LIMITER` is **removed**, because any attacker-reachable shared limit lets other accounts' traffic silence the
notice for a takeover.

- **Caps** (`NOTICE_CAPS`): per account, per kind, at most 3 an hour and 10 (sign-in) or 5 (reset) a day.
- **Over the cap, coalesce and defer.** `UserSecurityDO.claimNotice` keeps `notices(kind, sent_ms)` and one row per kind
  in `pending_notice(kind PK, count, first_event_ms, last_event_ms, last_country, list_was_empty, due_ms, attempts)`:
  everything the notice needs (`PendingNotice`, below), so the deferred send needs no request (G2). A notice the cap
  refuses, or whose `notBeforeMs` is in the future (the wave's jitter), is folded in: `count + 1`, `first_event_ms`
  kept, `last_event_ms` and `last_country` set to this event, `list_was_empty` OR-ed, and `due_ms =
  foldedDueMs(...)`: the earlier of the old due time and this event's `notBeforeMs`, never before the cap reopens (m2).
- **Sending the deferred notice.** `UserSecurityDO`'s alarm, already armed for its earliest due time (§4.1), builds the
  notice from the row: the sign-in time and country of `last_event_ms` and `last_country`, "This notice also covers
  N other new sign-ins since <first_event_ms>", `listWasEmpty`, and the link from `CANONICAL_ORIGIN` (§4.2). It reads
  the address with the `anonymised_at IS NULL` query on `HYPERDRIVE_FRESH` and sends with `postmarkSend`, from inside
  the Durable Object; Workers bindings, Hyperdrive included, are in a DO's `env`, and the implementer verifies this
  path on the installed runtime first (if it fails, the work returns to the PM; there is no fallback path). A claim
  that is allowed while a pending notice exists sends now and folds the pending row in (`coalesced`), clearing it.
- **End states (G1).** A pending notice is in exactly one of the `NoticeState`s: `pending` (waiting for `due_ms`),
  `retrying` (a send was refused for a transient reason), or one of four terminal states:
  - **`sent`**: Postmark accepted it; the row is deleted and the send counts against the cap.
  - **`dropped_account_gone`**: the address query found no live row, or a reaper called `dropPendingNotices()`
    (§4.5). The row is deleted and one line is logged, `account-notice: dropped dropped_account_gone <kind>` (no id,
    no address). No operator alert: the account no longer exists.
  - **`dropped_permanent_refusal`**: Postmark refused the recipient for good. `postmarkSend` collapses every failure
    to `false` (`auth/postmark.ts:58-74`, reading `res.status` at `:58-64` and `ErrorCode` at `:66-67`), so the design
    adds a sibling that returns a `PostmarkOutcome` (status and `ErrorCode`), with `postmarkSend` kept as its boolean
    view for the existing callers. ⚠️ The sibling must parse the JSON body on a non-2xx response too: Postmark reports these per-recipient refusals as HTTP 422 with an `ErrorCode` body, and the existing code returns at `!res.ok` before reading it, so a copy of that shape would never see 300 or 406 and every permanent refusal would retry until `dropped_expired`. Pin a 422-with-406 case in the tests. `classifyPostmark` treats `ErrorCode` 300 (send validation, such as an invalid
    address) and 406 (inactive recipient) as permanent, per Postmark's API error-code table (fetched 2026-10-07: 300
    "Send validation …", 406 "Inactive recipient"). The row is deleted at once and logged.
  - **`dropped_expired`**: every other failure is transient (a thrown request, a timeout, HTTP 429 or 5xx, and
    account-level codes such as 10, 412 or 1480, which an operator must fix). The row moves to `retrying`, retried
    after `noticeRetryDelayMs(attempts)`: 15 minutes, doubling, at most every 6 h. Once `first_event_ms` is
    `NOTICE_MAX_AGE_MS` (7 days) old, it is deleted and logged.

  Each of the two Postmark drop states sends **one operator alert per state per UTC day**: `UserSecurityDO` calls the
  ledger's `noticeDropped(endState)`, which queues one `notice_dropped` message (drop state, day, count so far today),
  exempt from budgets, and counts the rest for the digest. Postmark is called about 32 times per notice over
  its 7 days at most, not every 15 minutes forever.
- **The bound.** Wave jitter is under 6 h (`WAVE_SPREAD_MS`); a cap deferral is under 24 h (`capReopensAt` only counts
  sends within the last day), so `NOTICE_MAX_DELAY_MS` = 30 h. Past it, only a Postmark refusal can delay a notice, and
  then only into `retrying` and, at worst, a logged and alerted drop.
- **Bombing is already hard, and the caps bound it.** A sign-in notice needs a correct password; a reset notice needs
  a redeemed token from the holder's mailbox. With the password, an attacker signing in from fresh browsers in a loop
  gets the account at most 3 mails an hour and 10 a day, the rest coalesced into the next one. This design adds nothing
  an anonymous caller can trigger; signup and forgot-password already mail under their own limiters
  (`routes/signup.ts:159-171`, `routes/forgot-password.ts:88-98`).

### 4.5 Anonymised accounts, deletion requests, bars and legal holds

- **Anonymised accounts get no notices, structurally.** Login can't succeed: the password hash becomes the constant
  `"!anonymised!"` (`auth/anonymise-accounts.ts:79`), which no Argon2id output matches. Reset can't succeed: the peek and
  the write both require `anonymised_at IS NULL` (`reset-password.ts:136`, `:181`). The notice query adds
  `anonymised_at IS NULL` anyway, and the scrubbed address is undeliverable by construction
  (`anonymise-accounts.ts:60-68`). Three independent stops.
- **The anonymise reaper** calls `forgetDevices()`, `dropPendingNotices()` and `ledger.forgetAccount(userId)` beside its
  post-scrub epoch bump
  (`anonymise-accounts.ts:158-163`), with that block's failure handling: log and continue. The backstops if either
  fails: the device alarm's 400-day pruning, and the ledger's 7-day ref expiry.
- **The unverified-account reaper** hard-deletes rows (`auth/reap-unverified.ts:63-77`) and touches no DO today (0 hits
  for `USER_SECURITY` in that file; the same grep finds `anonymise-accounts.ts:134` and `:161`). Its `DELETE` gains
  `RETURNING id`, and it calls `forgetDevices()`, `dropPendingNotices()` and `ledger.forgetAccount()` per id.
- **Subrequests (m-g).** The anonymise loop goes from 2 DO calls per account (two epoch bumps,
  `anonymise-accounts.ts:134`, `:161`) to 5, at `REAP_BATCH` = 500: 2,500 DO calls per run, plus its Postgres
  queries; the unverified reaper adds 3 per deleted account, 1,500 per run. Cloudflare's limits page (fetched
  2026-10-07) gives Workers Paid "10,000 (up to 10M)" subrequests per invocation and does not say whether DO calls
  count; even if every one does, a run stays well under 10,000. The implementer confirms the count in a test run.
- **Pending deletion** (`deletion_requested_at` set, not yet anonymised): notices still fire; a sign-in during the
  30-day window is exactly what the holder should hear about.
- **Barred accounts:** login refuses before minting a session (`login.ts:336-341`, `:397-400`), so no sign-in notice. A
  reset on a barred account changes the password but mints no session (`reset-password.ts:279-289`); it gets the reset
  notice, mints no device cookie, and forgets every browser (§4.1).
- **Legal holds** gate deletion only (`moderation/account-holds.ts:4-6`; `anonymise-accounts.ts:11-20`). A held
  account's holder gets the same notices as anyone; they mention no hold, moderation state or reason, so they can't tip
  anyone off. A hold stops anonymisation, so it also stops the reaper's `forgetDevices()` and `forgetAccount()`, but not
  the 400-day alarm or the 7-day ref expiry. The device list, the counters and the ledger are not evidence under the
  hold specs, and this design doesn't add them.

### 4.6 The privacy policy (D5)

- `docs/legal/privacy-policy.md:23-25` says the Service sets "a session cookie" and no tracking cookies.
  `__Host-tj_device` is a second, first-party, strictly-necessary security cookie. It identifies a browser per account
  (the stored value is keyed by the account, §4.1), but the cookie itself is one value per browser, shared by every
  account signed in on that browser.
- The security-data line (`:20-22`) and the security-log retention line (`:154`) should name:
  - the device list and its 400-day bound;
  - the counters' 60-minute bound;
  - **the ledger:** an account under attack is held by user id for at most 7 days after the last alert about it (its
    ref); an attacked subject (an IP prefix or an account ref) is listed until a delivered report covers it, then for
    7 more days on the admin page;
  - **the audit log:** an administrator's lookup of an alert reference is kept permanently in the moderation audit log,
    recording the administrator and the reference, not the account (R4).
- **The alert transport is a processor.** After board 131, operator alerts (IP prefixes, account refs, counts) go to a
  third party. The policy should say so.
- That wording ships before `ACCOUNT_NOTICES_ENABLED` is `"1"`, and the processor line before
  `SECURITY_ALERTS_ENABLED` is `"1"`.

## 5. Testing plan (RED first)

Every test below is written and seen failing before the code that passes it. Pool tests run in workerd
(`apps/api/vitest.config.ts`, `@cloudflare/vitest-pool-workers`); the shared package's tests run in Node. **Mutation
controls:** for each guard named below, the implementer breaks the guard, sees the test fail, and restores it.

**`packages/shared` — `security-signals.test.ts`:**
- One test per rule, with a matching event and a non-matching control.
- A login `auth_failure` with `{ email, userId }` and an IPv4 address yields exactly six increments, by name:
  `login_ip_burst`, `credential_stuffing`, `slow_stuffing`, `targeted_account`, `distributed_account_guess`,
  `login_failure_storm`. Without `userId`: four.
- **A login 429 yields exactly one increment, `rate_limit_storm`**: no `login_ip_burst`, no per-/64 row (§2.5). Control:
  the login failure above does yield `login_ip_burst`.
- Two IPv6 addresses in one /64 give the same subject and shard; two in different /64s give different subjects.
  IPv4-mapped is the IPv4 subject. `shardFor` always returns one of the 33 names.
- `reset_token_burst`: two IPv6 addresses in different /64s of one /48 give the same subject (`…::/48`); two IPv4
  addresses in one /24 give `a.b.c.0/24`, and an IPv4-mapped address its IPv4 /24; `300.1.1.1` is returned unchanged
  (m3). Control: `login_ip_burst` for the
  same pairs gives two subjects each.
- `ip: null` gives subject `none` and a `missing_client_ip` increment, except for `/internal/purge` and for
  `alerting_fault` events.
- A user-keyed 429 (`/comments`, bucket `user`) yields exactly one increment, `rate_limit_storm`.

**`packages/shared` — `security-log.test.ts`:** the observer is called once per event, with the counting argument.
**No PII in the log:** with `{ email: "<fixture>@example.invalid" }`, no argument of the spied `console.warn` contains
the address after `JSON.stringify`; positive control: the observer did receive it. An observer that throws doesn't make
`logSecurityEvent` throw, and the line was still written.

**`packages/shared` — `security-alert.test.ts`:** `selectSecurityAlertSink` (flag off → log sink; flag on, factory
present, `SECURITY_ALERT_EMAIL` empty → log sink plus a `console.error` whose `missing` names the key, and contains no
secret value from the fixture env; fully configured → the factory's sink). `deliverSecurityAlert`: a throwing sink →
`delivered: false`; a never-resolving one → `"timeout"` (fake timers). **No PII in messages:** build one of each message
type per signal from fixtures; `JSON.stringify` contains no `@`, no fixture password, token, limiter key or user id;
an account subject carries only `ref`; the keys are exactly the declared fields.

**`packages/shared` — `security-ledger-policy.test.ts`:** `decide` for every class: send, then cooldown, then (after
cooldown) send, until the budget; the first budget refusal of a subject-mode class queues `budget_exhausted`, the second
doesn't; a summary class summarises after its onset and is never refused. **The decoy test:** exhaust `purge`, `storm`
and `ip_burst` completely, then one `targeted_account` crossing → `send`. `dailyMessageCeiling()` is 96. **Summary
invariant (m-c):** for every summary class, `dailyBudget` ≥ its number of signals, so it can never be refused.
`HeldReportBuilder` refuses the entry that would pass the byte cap and every one after it.

**`packages/shared` — `security-buffer.test.ts`** (injected `sleep`, fake scope):
- 100 user-keyed 429s (one increment each) → no `record` until `sleep` resolves, then exactly one `record`, to `site`,
  whose row has `n = 100`.
- 60 login failures (no account) from 60 different /64s → 50 /64 subjects counted; the last 10 events' 20 ip-shard
  increments become `overflowEvents` on the `site` batch, while all 60 still reach `site`'s own rows.
- 300 account failures across 300 accounts and 60 /64s → account subjects are capped at 200, independently of the /64
  cap.
- A `record` that rejects → one count-only `console.error`, and `flush` resolves.

**`apps/api` — `security-scope.test.ts`:** `withSecurityScope` returns the handler's own `Response` object, calls the
handler once, and does so with `SECURITY_COUNTING="off"`, with an observer that throws, and with `stubFor` rejecting.
`route-protection.test.ts`'s updated snapshot contains exactly the changes in §2.2's table.

**`apps/api` — `security-counter-do.test.ts`** (pool, `runInDurableObject` with an explicit clock):
- **The threshold boundary for every rule:** at threshold − 1 no report; at the threshold exactly one; more events in
  the same window → still one (`last_report`); the next window still over threshold → a second report.
- **The window:** events older than `windowMinutes` don't count; a burst straddling a minute boundary does.
- **Distinct measures (m2):** `credential_stuffing` with 12 failed logins for 12 different addresses from one /64 →
  10 distinct counted (the first two events store no member) → exactly one report; with 11 addresses, none. Ten
  failures for one address count 1 distinct. The `members` table holds no row equal to or containing an address.
- **Uncapped events:** 500 failures against one account → the report's `events` is 500 while `observed` (if distinct)
  stops at 2 × threshold.
- **Unreachable ledger (N3):** with the ledger stub rejecting, the report stays in `reports` through any number of
  alarms, `next_ms` follows 1, 5, 15, 15… minutes, each failed attempt logs one `security: alerting_fault` line, no sink
  is ever called from the counter, and `deleteAll` doesn't run while it is pending. Once the ledger accepts, the row is
  deleted.
- **Retention:** after `alarm(now + 61 min)` with nothing pending, storage is empty (positive control: non-empty
  before); a later `record` creates a new salt.

**`apps/api` — `security-ledger-do.test.ts`** (pool, explicit clock, `sinkFactory` replaced with a capturing sink):
- **Held subjects survive the alarm (C2):** send an alert (cooldown 1 h); suppress two reports during it; run `alarm`
  at `until_ms + 1 s`, which prunes the cooldown row; then a new report → sent; the next held-subject report names
  the subject with `suppressed: 2`. With the sink answering `delivered: false` four times, the `held` row survives and
  the following report names it again; only a delivered report deletes it.
- **Bounded reports and caps (R1, F3):** spend the `account` and `stuffing` budgets, then report 25,000 decoy /64s with
  `credential_stuffing` and 1,000 decoy accounts with 1,000 uncapped events each, plus one real target account with
  31. Each `held_report` message is under 64 KB of entries; the alarm's queries each return at most 200 rows;
  `targeted_account` comes first, so the real target is named in the first report. `stuffing` stores exactly 20,000
  rows; the other 5,000 are counted in `held_overflow`; exactly one `held_capped` message for `stuffing` goes out that
  day; every report and digest shows the 5,000. After a delivered report covers rows, new subjects evict covered rows
  before anything more is counted. `GET /admin/security/held` pages through every stored row.
- **Versions (F2):** a named subject that crosses again between the report's snapshot and its delivery survives the
  delivery with its new events and is named again by the next report; a covered subject that crosses again is open
  again. With the clock held still, rows written after the snapshot are open, not covered (the sequence, not time,
  decides).
- **Admin cursor (F2):** while paging, raise one row's `events` above every other and delete another row; the full
  walk lists every remaining row exactly once.
- **Pruning keeps up (F3):** with 10,000 aged-out covered rows, one alarm prunes until its 2 s budget, re-arms for now,
  and the next run finishes; storage never exceeds the caps.
- **Independent steps (R1):** with `site.summarise` throwing and the digest step failing, the heartbeat and the
  held-subject report still go out in the same alarm, and the KV liveness key is still written.
- **Budget exhaustion:** the 7th `ip_burst` alert in a day is refused, exactly one `budget_exhausted` message goes
  through the sink, and the next digest carries the refused count.
- **Heartbeat (N2, m-d):** a day with no reports at all → exactly one `heartbeat`, from the first alarm at or after
  09:00 UTC, with `lateMinutes: 0`; with the alarm first running at 10:05, `lateMinutes: 65`, and still exactly one
  that day. `report()` with nothing queued still leaves an alarm set. With the alarm deleted, the next `*/2` cron run's
  `ensureLedgerAlarm` sets one; a second call changes nothing.
- **Health (R2):** after an alarm, `GET /health/security-ledger` answers exactly `{"status":"ok"}` with 200 and the
  ledger stub set to throw (it makes no DO call); with the KV key 2 hours old, `{"status":"stale"}` with 503; the web
  page passes the status through and sets a 60 s edge cache.
- **Undeliverable:** after 4 failures the message is written through `LogSecurityAlertSink` in full, dropped, and the
  next digest says `undeliverable: 1`.
- **Config fault (N5):** `ACCOUNT_NOTICES_ENABLED="1"` and no `DEVICE_HASH_KEY` → one `config_fault` that day, not two.
- **Refs (N6):** two alerts about one account carry the same ref; the ref resolves through
  `GET /admin/security/account-ref/:ref` for an admin and writes exactly one `moderation_actions` row with action
  `security_ref_resolved`, the admin's identity, the ref in `internal_note`, and `subject_user_id` NULL (R4); an
  unknown ref and a ref unused for 7 days both give the same 404 and write nothing. Reading the account's moderation
  history and appeals as that member returns no such row.
- **Anonymisation (N7, m-e):** after `anonymiseExpiredAccounts`, the ledger has no `account_refs`, `held` or
  `cooldowns` row for that user (positive control: it had all three before); a report about that user delivered
  afterwards, as from a counter that waited out an outage, re-creates nothing; after the tombstone's 30 days it would.

**`apps/api` — `login.test.ts` and `reset-password.test.ts` (extended)**, using `setSecurityScopeOverridesForTests`:
- **Counted, by name:** a wrong password for a real account → after a flush, `acct:<shard>` holds one
  `targeted_account` event for that user; a nonexistent address → no account increment.
- **Delivery failure doesn't break auth:** with `stubFor` rejecting, a wrong password still answers the byte-identical
  401, and a correct one 200 with `Set-Cookie`. Assert the body, not just the status.
- **Off the response path:** with a buffer whose `sleep` never resolves, the response resolves and no `record` ran.
- **Kill switch:** `SECURITY_COUNTING="off"` → the `security:` line is still logged and no `record` ran.

**`apps/api` — account notices** (pool, Postmark intercepted as in `test/forgot-password.test.ts:33-57`):
- **Signup is silent:** signup → no mail, the device recorded.
- **Rollout case:** an account with an empty list → its first login mails, and the body has the "no browser on record"
  sentence.
- **New device:** a login without the cookie, after a login that set one → exactly one mail, without that sentence.
- **Known device:** a login with the cookie that the previous login set → no mail (control: the previous case).
- **Expiry:** an entry last seen 401 days ago, after `alarm` runs → that browser's login mails.
- **Re-signup clears:** claimant A signs up (device A recorded); claimant B re-signs-up the same unverified address →
  device A is gone; a later login presenting A's cookie mails.
- **Reset clears all but one:** devices A and B known; reset from C → the list is exactly {C}; login with A mails.
- **Barred:** login → no mail. A reset on a barred account → one "password was changed" mail, no `Set-Cookie` at all on
  the response, and an empty device list.
- **Key rotation (N5):** a browser recorded under key K1; set `DEVICE_HASH_KEY=K2`, `DEVICE_HASH_KEY_PREV=K1` → its
  login doesn't mail and its entry is rewritten to K2; then remove `_PREV` → the same browser still doesn't mail.
  Control: a browser recorded under K1 that didn't sign in during the rotation mails once `_PREV` is gone.
- **Missing key (N5):** no `DEVICE_HASH_KEY`, notices on → a new browser's login sends no mail, records nothing, and logs
  one `security: alerting_fault … device_hash_key_missing` line; a reset still mails.
- **Anonymised:** no mail via a direct call to the notice function for that id; positive control: the same call for a
  live account mails.
- **Takeover under saturation (F1):** 50 attacker-controlled accounts each sign in from new browsers as fast as their
  limiters allow, and the victim's own cap is exhausted by three earlier new-browser sign-ins in the hour; then the
  attacker signs in to the victim's account from a new browser. The victim receives a notice for that sign-in: at
  once if the victim's cap allows, otherwise exactly one deferred notice when the window reopens, which says "also
  covers N other new sign-ins since …". No other account's traffic changes when or whether the victim's notice is sent.
- **Wave spread (F1):** replace the key without `_PREV`; a known browser's next sign-in → `unknownKeysOnly`; the notice is
  pending with `due_ms` within 6 h, not sent and not dropped; the alarm sends it then. With `random` fixed, `due_ms` is
  exact.
- **Deferred notice content (G2):** a takeover sign-in from `DE` at T folded behind the cap is sent hours later with
  T and the country name, not the send time; the link is `CANONICAL_ORIGIN` + `/forgot-password` with no request in
  scope; a fold with an empty-list event keeps the empty-list sentence. Folds keep `due_ms` at the earlier value, never
  before the cap reopens (`foldedDueMs`).
- **End states (G1):** a transient refusal (HTTP 503) → `retrying`, retried at 15, 30, 60 minutes … at most every 6 h,
  then sent once Postmark accepts; transient refusals for 7 days → `dropped_expired`, logged, one `notice_dropped`
  that day for any number of such drops; `ErrorCode` 406 → `dropped_permanent_refusal` at once, logged, one
  `notice_dropped`; a pending notice for an account the anonymise reaper scrubs, or the unverified reaper deletes →
  `dropped_account_gone`, logged, no alert, no Postmark call; a barred reset (`forgetDevices`) leaves pending notices
  alone. `classifyPostmark` is pinned for 300, 406, 10, 412, 1480, HTTP 429 and 500, and a thrown request.
  `capReopensAt` is never more than 24 h after now.
- **Cap:** after one known-device login, four logins from four new browsers within an hour → three mails; the next
  deferred one, sent when the window reopens, says "also covers 1 other new sign-in since …" (the count lives in
  `pending_notice`).
- **Flag off:** no Postmark call, one `account-notice: would_send` line, and the cap is not consumed.
- **No IP in notices:** the body contains neither the request's IP nor its /64. With `X-TJ-Client-Country: DE` it
  contains the country name; with none, no "from" phrase.
- **Cookie:** production string `__Host-tj_device=…; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=34560000` and the
  dev string are both pinned; `logout`'s `Set-Cookie` list names only the session cookie.
- **HMAC:** the same token under two user ids gives two different stored hashes; the stored hash is not the token's
  plain SHA-256.
- **Reapers:** after `anonymiseExpiredAccounts`, and after `reapUnverifiedAccounts`, the account's `known_devices` is
  empty; after the anonymise run the epoch is still the bumped value. (`UserSecurityDO` is never fully empty: its
  constructor re-seeds the `security` row, `UserSecurityDO.ts:37-40`.)

**`apps/web`:** `purge.test.ts`: a wrong secret calls `onSecurityEvent` once, a right one never; a flood of 50 wrong
secrets produces one `record` per flush, not 50; with `SECURITY_COUNTING="off"` the page passes a no-op and no `record`
runs. `client-ip-store.test.ts`: the same overwrite, delete and enumeration cases for `X-TJ-Client-Country`. The
`security-ref` admin page and the `/health/security-ledger` page each get the structural tests their siblings have.

**Implementer confirmations (m5), each before writing the code that depends on it:**
1. A cross-script Durable Object binding with RPC works from the Astro web Worker (§2.2).
2. `runInDurableObject` (from `cloudflare:test`, not yet used in this repo) works on the installed pool.
3. A stub created inside one request's `waitUntil` can be used there by the buffer's flush (§2.5).
4. `env.SECURITY_COUNTER.getByName()` stubs are assignable to `SecurityCounterRpc` under `pnpm typecheck` (§8).
5. Which of `request.cf.country` or `CF-IPCountry` reaches `middleware.ts`, and that `Intl.DisplayNames` works in
   workerd (§4.2).
6. Whether DO calls count toward the 10,000-subrequest limit, by counting a reaper run (§4.5).
7. Hyperdrive and outbound `fetch` work from inside `UserSecurityDO` (§4.4).

The same list is not repeated elsewhere. The implementer also confirms, in workerd, that a flush started in one request's `waitUntil` may
call the counter stub it creates there (§2.5's buffer creates stubs at flush time, inside that request).

## 6. Rollout

| Phase | Ships | Flags | Depends on |
|---|---|---|---|
| **1. Implementation PR** | shared observer, signals, buffer, ledger policy and seam; `SecurityCounterDO` + `SecurityLedgerDO` (+ DO migration `v4`); `scope.ts`; the cron's `ensureLedgerAlarm`; the log sink; the web purge binding; device cookie, `UserSecurityDO` tables and alarm; notice code with deferral; reaper hooks; the admin security page and its two routes; the `moderation_actions` constraint migration; `/health/security-ledger` | `SECURITY_COUNTING` on; `SECURITY_ALERTS_ENABLED="0"`; `ACCOUNT_NOTICES_ENABLED="0"`; `DEVICE_HASH_KEY` set | the migration applied first (below); deploy api, then web (§2.2) |
| **1b. Notices on** | `ACCOUNT_NOTICES_ENABLED="1"` | | `DEVICE_HASH_KEY` confirmed set in production; D5; Postmark delivery confirmed |
| **2. Board 131** | the transport sink and factory, replacing `null` in one call; `SECURITY_ALERT_EMAIL` and `SECURITY_ALERT_RELAY_TOKEN` set; then `SECURITY_ALERTS_ENABLED="1"` | | D1, D5 (processor line) |
| **2b. Uptime monitor** | per D2, alerting through the same transport | | D1, D2 |

**The Postgres migration and the deploy gate (R5).**
- **Its number is allocated at implementation time** by the PM, not here: another lane may take the next number first.
- **It is applied before the deploy.** Each Worker's build runs `scripts/check-migrations-applied.mjs` first, which
  "FAIL[s] CLOSED, ALWAYS" unless production reports the newest migration applied (its header; it asks the deployed
  web Worker's `/health/schema`). So the order is: apply the migration to production, then merge, and the build's gate
  passes.
- **It carries no after-code marker.** The marker, `-- deploy: after-code` (`scripts/lib/migration-gate.mjs:54`), is
  for destructive migrations that must run after the code. This one is additive (a strict superset of the CHECK list)
  and must run before the code that writes the new kind.

**Other notes.**
- **Before board 131,** every alert, `budget_exhausted`, `config_fault`, digest, held-subject report and heartbeat is a
  `security-alert:` line in Workers Logs. A week of them is how D3's thresholds get checked against real traffic.
- **Device recording starts in phase 1**, flag or no flag, so by phase 1b many active accounts already have their
  browser on record and the rollout-notice wave is smaller; per-account caps coalesce what remains (§4.4).
- **Turning it off:** see §3.1 on where the vars live; a dashboard edit is reverted by the next deploy.
- **The version number** is allocated by the PM at gate time, per the standing rule.

## 7. Open decisions for CireSnave (via the PM)

**D1 — the alert transport (board 131).** This spec designs the seam only.

| Option | For | Against |
|---|---|---|
| (a) `postmarkSend` on the existing server token | no new vendor or secret; ~20 lines | shares quota, reputation and outages with user mail; the attack being reported can silence its own alert (§3.4) |
| (b) A separate Postmark server; its token is `SECURITY_ALERT_RELAY_TOKEN` | splits quota and reputation from user mail | still one vendor; a second server to run |
| (c) A push or webhook relay (a chat or push-notification service); its secret is `SECURITY_ALERT_RELAY_TOKEN` | independent of mail; reaches a phone fastest | a new third-party processor (D5); a webhook URL is itself a secret |
| (d) Cloudflare Email Routing's `send_email` binding to a verified destination | no third party; no token | sends only to addresses verified in Email Routing on the zone (not verified here); shares Cloudflare as a failure domain |

**D2 — the external uptime monitor.** `prod-smoke` is scheduled `*/15` (`.github/workflows/prod-smoke.yml:12-13`), and
GitHub throttles it to every few hours (PM's report, not verified here), so "production is up" is checked only that
often. Options: a third-party external monitor (truly external); Cloudflare Health Checks (plan availability not
verified; shares Cloudflare as a failure domain); nothing beyond `prod-smoke`. **Option within any monitor:** also poll
`GET /health/security-ledger` (§2.6) and alert when it answers `stale` (no ledger alarm for 2 hours). That catches a
dead ledger within hours instead of at the next missed heartbeat. Whichever is chosen alerts through D1's transport.
**Recommendation:** decide with D1.

**D3 — thresholds and budgets, only if he cares.** Defaults in §1.3 and §2.6. **Recommendation:** ship them with the
log sink, review a week of `security-alert:` lines, and adjust before phase 2.

**D4 — for information, not a decision.** The PM ruled (round 1) that the only silent path is the signup browser.
Consequence: every existing account gets one "new sign-in" notice on its first sign-in after notices are switched on,
unless it signed in during phase 1 (§6).

**D6 — the floor under a storage bound (F3).** The PM's rulings ask that every subject over threshold in the
targeted-account and stuffing classes be reported. Storage must be bounded, so past 20,000 open subjects in one of
those classes (2,000 in the others), new subjects are **counted, not named**, with a `held_capped` alert and the
count in every report (§2.6). Options: accept the caps as set; raise them (each 10,000 rows is about 2 MB, against a
10 GB object limit); or treat reaching the cap as an incident that pages someone through D1's transport.
**Recommendation:** accept, and review the caps with D3.

**D5 — privacy-policy wording**, for approval: the `__Host-tj_device` cookie and the per-account device list with its
400-day bound; the counters' 60-minute bound; the ledger's retention of an attacked account's user id (at most 7 days
after the last alert about it) and of attacked subjects (until a delivered report covers them, then 7 days); the
permanent audit-log record of an administrator's lookup of an alert reference, which records the administrator and
the reference, not the account (R4); and the alert transport as a third-party processor once board 131 picks one
(§4.6).

## 8. TypeScript check

Every `ts` block above was copied verbatim, by script, from the spec into a scratch project outside `C:\Projects`: one
file per module (the two `account-notices.ts` blocks joined), a copy of `limiter-ip-key.ts` from `12d47c8`, and a shared
index; `@thinkersjournal/shared` was mapped by `paths` to that index. TypeScript 6.0.3 with `strict`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` and `@types/node` (for
`node:async_hooks` and WebCrypto). Result: `tsc -p` exited 0 over 9 files (the 7 spec modules, the shared index, `limiter-ip-key.ts`). **Positive control:** appending `export const probeCtl: number = "x";` to each of the 7 modules gave TS2322 in every one, and `export const probeImport: number = classifyPostmark;` gave TS2322 naming its real signature; restored, `tsc` exited 0 again. **Executed** (compiled with the same compiler, run on Node 26.5.0): `networkKey` gives `203.0.113.0/24` for `203.0.113.9` and leaves `300.1.1.1` unchanged; `dailyMessageCeiling()` is 96; `classifyPostmark` gives permanent for 300 and 406, transient for 10, 412, 1480 and HTTP 503, and sent for an accept; `noticeRetryDelayMs` gives 15, 30, 60, 120, 240, then 360 minutes, which is 32 attempts in 7 days; `foldedDueMs` keeps the earlier due time and never goes before the cap reopens.

Not checked: `index.ts`, the DO classes and the web pages are prose here, so the assignability of
`env.SECURITY_COUNTER.getByName(s)` to `SecurityCounterRpc` is left to the implementer's `pnpm typecheck`. The `sql`
block is illustrative DDL and was not executed.

## 9. Audit findings and where each is answered

**Revision 5 (final audit of 75fbd2a).** Net change: **removed** the cron fallback for deferred notices and the
request-derived notice link. **Added** the deferred notice's stored fields, its named end states with Postmark error
classification, backoff and a 7-day maximum age, a `notice_dropped` operator alert, `dropPendingNotices` for the
reapers, and bounded counter reports.

| Finding | Answer |
|---|---|
| G1 deferred notice never ends | named states `pending`, `retrying`, `sent`, `dropped_account_gone`, `dropped_permanent_refusal`, `dropped_expired`; 300/406 permanent, others transient with backoff to 7 days; one `notice_dropped` per drop state per day; reapers drop pending notices with a log line (§4.4, §4.5, §5) |
| G2 deferred notice can't be built | `pending_notice` stores the last event's time and country, `list_was_empty` and the coalesced count; link from `CANONICAL_ORIGIN`; cron fallback deleted (§4.2, §4.4) |
| m1 watermark regression | `W = max(W, S)` (§2.6) |
| m2 fold due time | `foldedDueMs`: earlier of old and new, never before the cap reopens (§4.4) |
| m3 octet range | `networkKey` returns out-of-range IPv4 unchanged (§2.3 code) |
| m4 counter reports unbounded | merged per (signal, subject); 10,000-row cap, overflow counted (§2.4) |
| m5 confirmations | one numbered list (§5) |

**Revision 4 (fourth audit of 42d3540).** Net change: **removed** the site-wide `NOTICE_LIMITER` and timestamp-based
coverage. **Added** coalesced, deferred per-account notices with the delay invariant, wave jitter with key ids, held-row
versions from a ledger sequence, the immutable admin cursor, per-class row caps with counted overflow and a
`held_capped` alert, looping pruning, the IPv4 /24 network key, and a 503 for `stale`.

| Finding | Answer |
|---|---|
| F1 site-wide limiter silences a takeover notice | limiter removed; per-account cap coalesces into one deferred notice; wave spread by jitter; nothing dropped; 30 h invariant; takeover-under-saturation test (§4.4, §5) |
| F2 cursor and coverage inconsistent under churn | immutable (class, subject_key) cursor; versions from a ledger sequence; delete only if version ≤ named version; sequence watermark (§2.6, §5) |
| F3 prune slower than inserts | prune loop with time budget and immediate re-arm; per-class row caps, overflow counted, `held_capped` alert; D6 (§2.6, §7) |
| F4 IPv4 reset worst case | IPv4 /24; cost recomputed for both families; worst case stated as ≈ 5.7–6.5× at ≥ 6,000 networks (§2.5) |
| Notes | `stale` is 503; `ok` means the alarm runs; `ModerationActionKind` union named (§2.6) |

**Revision 3 (third audit of f943197).** Net change: **removed** the subject list from the digest and the digest's role
as heartbeat, and the health endpoint's DO call and timestamps. **Added** one-row-per-subject `held` storage with paged,
byte-capped reports and a covered watermark, separate heartbeat and held-report messages and alarm steps, the KV
liveness key, the cron `ensureAlarm`, the held-list admin view, the forget tombstone, a notice limiter (removed in revision 4), the /48 subject
and `WITHOUT ROWID`.

| Finding | Answer |
|---|---|
| R1 one-row digest wedges the ledger | `held` is one row per subject; reports page in 200-row queries up to 64 KB, class-priority order, "N more" plus the admin link; watermark marks coverage; separate heartbeat, report and digest steps with their own error handling; 50,000-subject test (§2.6, §5) |
| R2 public DO call; `lastDigestAt` oracle | KV liveness key; route returns only `ok`/`stale`, no DO call, 60 s edge cache (§2.6) |
| R3 readers undercounted | grep command, 17 lines in 16 statements, all cited (§2.6) |
| R4 audit row keeps the user id | row stores the ref and the admin only; D5 wording (§2.6, §4.6, §7) |
| R5 stale "no migration"; gate order | §2.1 corrected; number allocated at implementation; applied before deploy; no after-code marker (§6) |
| R6 cheaper mitigation | `reset_token_burst` per /48; `WITHOUT ROWID`; worst case now ≈ 1.4–1.6× (§2.4, §2.5) |
| m-a decoy cost | corrected per signal (§2.6) |
| m-b `alerting_fault` comment | corrected, and the `security:` contract note (§2.2 code) |
| m-c summary invariant | test that every summary class's budget ≥ its signal count (§5) |
| m-d late heartbeat | first alarm at or after 09:00 sends it with `lateMinutes`; cron `ensureAlarm` (§2.6) |
| m-e late report undoes forget | 30-day tombstone checked by `report()` (§2.6) |
| m-f key-restore wave | stated in the rotation procedure (revised by F1) (§4.1, §4.4) |
| m-g reaper subrequests | counted against the 10,000 limit (§4.5) |

**Revision 2 (re-audit of d2f930c).** Removed the counter-to-sink fallback, the floor's top-20 cut, per-/64 counting of
429s and the "N other browsers" count; added the heartbeat, the health endpoint, `config_fault`, versioned device keys,
the ref admin page with its audit row, and `forgetAccount`.

| Finding | Answer |
|---|---|
| N1 floor defeated by decoys | every held subject reported, ranked by uncapped events (delivery made bounded by R1) |
| N2 dead ledger looks quiet | daily heartbeat; `report()` always arms an alarm; health endpoint (revised by R2, m-d) |
| N3 fallback breaks refs | fallback removed; counters retry and log `security: alerting_fault` (§2.4) |
| N4 cost | deletes and alarms priced (revised by R6) |
| N5 key rotation; missing key | `DEVICE_HASH_KEY` + `_PREV`; missing key disables device notices (§4.1) |
| N6 ref route; audit | admin page and audit row (revised by R3, R4) |
| N7 ledger retention | minimal retention; `forgetAccount` (revised by m-e) |
| m1–m7 | ceiling, test, browser count, barred cookie, citations, web kill switch, grammar: corrected in place |

**Revision 1 (audit of 4b6fadd).**

| Finding | Answer |
|---|---|
| C1 budget exhaustion hides attacks | per-class budgets and cooldowns, summary classes, `budget_exhausted`, reports, floor (§2.6) |
| C2 suppressed counts lost | held rows live in the ledger until a delivered report covers them (§2.6) |
| C3 silent first device | no silent path but the signup browser; reset and re-signup clear the list (§4.1) |
| I1 dispatcher pin | `scope.ts`; named snapshot changes (§2.2) |
| I2 purge RPC per request | purge uses the shared buffer (§2.2) |
| I3 cross-DO call in a transaction | no RPC inside `transactionSync` (§2.4, §2.6) |
| I4 call bound and cost | fixed 33 counter instances; ≤ 33 RPCs per isolate per 5 s; priced (§2.5) |
| I5 test seams | `setSecurityScopeOverridesForTests`, injected `sleep`, ledger `sinkFactory` (§3.3) |
| I6 device hash linkage, retention | HMAC over user id and token; `UserSecurityDO` alarm (§4.1) |
| I7 payload privacy | opaque refs; prefixes only where they are the action; processor disclosure (§3.2, §4.6) |
| I8 cookie tossing | `__Host-tj_device` (§4.1) |
| I9 slow stuffing | `slow_stuffing` (§1.3) |
| M1–M9 | corrected in place |

