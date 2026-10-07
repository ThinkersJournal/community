# Deploy runbook — the migration gate (#116, shape A)

Companion to `docs/superpowers/specs/2026-09-27-deploy-automation-design.md`
(the design) and `docs/superpowers/specs/2026-09-02-least-privilege-db-role-design.md`
(the `app_runtime` cutover, if it ever happens — see its own dated note on
`pgmigrations`). This document is the operational half: what actually runs,
what CireSnave does by hand, and in what order.

## How a deploy works now

Cloudflare Workers Builds deploys `main` for both Workers
(`thinkersjournal-web`, `thinkersjournal-api`) on every push — this repo's own
CI (`.github/workflows/ci.yml`) and Cloudflare's git integration are two
separate pipelines; nothing here changes that. The migration gate
(`scripts/check-migrations-applied.mjs`) runs as the **first** step of each
Worker's **build command**, configured on the Cloudflare dashboard (not in
this repo — see the one-time change below). If the gate fails (any exit
other than 0), the build command fails and Cloudflare never deploys that
push — closing the #107/0019 incident this design exists to prevent.

The gate asks the **already-deployed, currently-live** production `web`
Worker (`GET /health/schema?migration=<name>`, proxied to the `api` Worker —
see `apps/api/src/routes/health-schema.ts` and
`apps/web/src/pages/health/schema.ts`) whether the newest gate-eligible
migration in `apps/api/migrations/` has been applied. No credential of any
kind was added for this (CireSnave ruled option 2 in the design's §4): the
deployed Worker answers from the database access it already has.

## Before editing: check each Worker's build root directory

Workers Builds runs the build command from whatever **"Root directory"** that
Worker's project is configured with in the Cloudflare dashboard — which is
**not necessarily this repo's root**, and the correct path to
`check-migrations-applied.mjs` depends on it:

- Root directory = repo root → `node scripts/check-migrations-applied.mjs`
- Root directory = `apps/web` or `apps/api` → `node ../../scripts/check-migrations-applied.mjs`

**Before relying on this**, CireSnave should either run the exact command once
in a shell at that root directory (so a typo or wrong relative path surfaces
immediately, not on the next real deploy), or watch the first real build log
after making the dashboard change below and confirm the gate's own
`MIGRATION GATE: checking ...` line appears rather than a "file not found"
build failure.

The script itself does not care which root directory it was launched from:
`scripts/check-migrations-applied.mjs` resolves `apps/api/migrations` from its
**own file location** (`import.meta.url`), never from `process.cwd()` — same
pattern as `apps/api/scripts/migrate.mjs`'s own migrations-directory
resolution — so it finds the right directory regardless of where the build
command's shell happens to be sitting.

## The one-time dashboard change (CireSnave)

For **each** Worker — `thinkersjournal-web` and `thinkersjournal-api` — open
its Cloudflare Workers Builds settings and change the build command to (using
the correct relative path for that Worker's root directory, per the section
above):

```
node scripts/check-migrations-applied.mjs && <the CURRENT build command>
```

The current build commands live only in the Cloudflare dashboard — they are
**not** in this repo (see `apps/api/src/routes/health-build.ts`'s own header
for why the `api` Worker in particular has no build script here to hook
into). **Keep whatever is there today after the `&&`; don't guess it.**

⚠️ **`MIGRATION_GATE_BASE_URL` must never be set in the Workers Builds
environment for either Worker.** It exists only so the gate script can be
pointed at a non-production host for local testing; setting it in the real
build environment would silently point the gate at the wrong host while
still deploying from this one. The script prints the base URL it actually
checked on every run (`MIGRATION GATE: checking <url> for migration
<name>...`), so a build log always shows if this has happened.

⚠️ **Ordering matters, and it only goes one way.** Make this dashboard change
**only after** this PR's code is live in production — production does not
serve `/health/schema` at all until the deploy that ships it lands, so
pointing the build command at the gate any earlier would make every build
fail closed against a route that doesn't exist yet. Confirm the route is
live first:

```
curl -s https://community.thinkersjournal.com/health/schema?migration=0001_users_and_profiles
# expect: {"applied":true}
```

Only once that returns as expected is it safe to make the dashboard change,
and only then for both Workers.

## Shipping a PR with an additive migration

0. **Step 0 (one-time, before the first deploy containing `reserved_email_hmac`):**
   set the `RESERVED_EMAIL_KEY` secret — see
   [One-time secret: `RESERVED_EMAIL_KEY`](#one-time-secret-reserved_email_key-0023-before-that-deploy-ships) below.

1. **Merge.** **Both Workers** carry the gate (per the dashboard change
   above), so the next build for **each** of `thinkersjournal-web` and
   `thinkersjournal-api` **fails at the gate** — this is expected, not a
   regression. The gate's own log line says which migration is missing:

   ```
   MIGRATION GATE: production has not applied 0020_dsa_notices — apply it
   (see docs/runbooks/deploy.md), then retry the build.
   ```

2. **The PM applies the migration manually**, using `TJ_PROD_DATABASE_URL` —
   **never** `DATABASE_URL`, per the design's §1/§4 naming discipline (the
   property that keeps this safe is that `DATABASE_URL` is never set to the
   production value anywhere an agent's ordinary invocation would pick it
   up). Confirmed against `apps/api/scripts/migrate.mjs`, which resolves its
   connection string from `process.env.DATABASE_URL` for the `dev` target
   (its default) — so the exact command shape is:

   **bash:**

   ```
   DATABASE_URL="$TJ_PROD_DATABASE_URL" node apps/api/scripts/migrate.mjs dev up
   ```

   **PowerShell:**

   ```powershell
   $env:DATABASE_URL=$env:TJ_PROD_DATABASE_URL; node apps/api/scripts/migrate.mjs dev up; Remove-Item Env:DATABASE_URL
   ```

   Run from a trusted machine. The credential is only ever set for that one
   command — never written to a file, a CI secret, or a shell profile — and
   the PowerShell form's trailing `Remove-Item Env:DATABASE_URL` clears it
   from the session afterward (bash's inline `VAR=value cmd` form does not
   leave it in the shell's environment to begin with).

3. **Retry the build** in the Cloudflare dashboard, **for both Workers**
   (for the 0023 deploy: only after Step 0's `RESERVED_EMAIL_KEY` is set)
   (whichever of them failed at step 1 — ordinarily both, since both carry
   the gate). The gate now sees `{"applied":true}` and each build proceeds —
   the deploy ships.

4. **`prod-smoke.yml` runs after the push**, as it already does for every
   push to `main` (unchanged by this work — see that workflow).

## One-time secret: `RESERVED_EMAIL_KEY` (0023, BEFORE that deploy ships)

`0023_reserved_email_hmac` makes a banned account's email reservation an
HMAC-SHA-256 keyed by the `api` Worker secret `RESERVED_EMAIL_KEY`
(`apps/api/src/auth/reserved-email.ts`). **Set the secret before the code that
needs it deploys**, i.e. before step 3's build retry for the 0023 PR:

```
openssl rand -base64 32 | npx wrangler secret put RESERVED_EMAIL_KEY --name thinkersjournal-api
```

(or the dashboard equivalent: Workers & Pages → `thinkersjournal-api` →
Settings → Variables and Secrets → add a **Secret** named `RESERVED_EMAIL_KEY`
holding 32 random bytes, base64-encoded). Never commit it, and never paste it
into a chat, an issue or a log.

Without it the code fails closed, by design: **every signup answers
`503 SERVICE_UNAVAILABLE`**, and the anonymisation reaper leaves each
**banned** account that is due for deletion unscrubbed (logged as a failed
row, retried nightly) while it scrubs the others normally.

⚠️ **Never rotate this key casually.** Every reservation stored under the old
key stops matching, which silently frees those banned users' addresses for a
new signup. A rotation needs a plan for the existing rows; there is none
today.

## Security alerting: the flags

`SECURITY_COUNTING` (api and web; "off" is the counting kill switch),
`SECURITY_ALERTS_ENABLED` and `ACCOUNT_NOTICES_ENABLED` (api) live in each
Worker's `wrangler.jsonc` `vars`. Flipping one is a one-line PR plus a deploy.
A dashboard edit works as an emergency stop, but **the next `wrangler deploy`
resets it to the file's value.**

Deploy order for the first deploy: the api (which creates the two Durable
Object classes, migration `v4`) before the web Worker (which binds the api's
counter class cross-script).

## Security alerting: turning it off and rolling it back

⚠️ **Do not use `wrangler rollback` (or the dashboard's Deployments view) to
take the api back to a version from before security alerting.** Cloudflare
refuses a rollback when "a Durable Object class lifecycle change (via
`exports` or the legacy `migrations` array) has occurred between the version
in the active deployment and the version selected to roll back to", and
migration `v4` (which creates `SecurityCounterDO` and `SecurityLedgerDO`) is
exactly such a change. Source: Cloudflare, "Rollbacks",
<https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/>
(page last updated 2026-07-15; read 2026-10-07). A plain `git revert` of the
whole PR will not deploy either: it drops the two class exports and the `v4`
entry while the classes still exist, and while the web Worker still binds
`SECURITY_COUNTER` cross-script.

Use these steps instead, in order, stopping at the first one that is enough:

1. **Stop counting.** Set `SECURITY_COUNTING="off"` on BOTH Workers (api and
   web). In an emergency, edit it in the dashboard, then land the same change as
   a one-line PR, because the next `wrangler deploy` resets the dashboard value
   (see the flags section above). Counting is the only thing PR 1 turns on:
   `SECURITY_ALERTS_ENABLED` and `ACCOUNT_NOTICES_ENABLED` are already `"0"`.
2. **Revert behaviour, keep the classes.** Revert the wiring only: the
   `index.ts` scope wrapper and its cron lines (`ensureLedgerAlarm`,
   `sweepForgottenAccounts`), login's counting argument, the reapers' forget
   calls, and the web purge page's counting sink. **Keep** both classes exported
   from `apps/api/src/index.ts`, keep their bindings, and keep migration `v4`
   in `apps/api/wrangler.jsonc`. This is the only code revert that is safe to
   deploy.
3. **Full removal (irreversible: deletes every counter and ledger object and
   all of its stored data).** Cloudflare's legacy-migrations page requires that,
   before a delete migration, the class's binding and every code reference are
   removed and no other Worker depends on it; a deploy that deletes a class
   another Worker still binds is rejected. Source: Cloudflare, "Durable Object
   class migrations (legacy)",
   <https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/>,
   and "Durable Objects migrations",
   <https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/>
   (both last updated 2026-09-28; read 2026-10-07). So:
   1. deploy the **web** Worker without its `SECURITY_COUNTER` binding (and
      without the code that uses it) first;
   2. then deploy the **api** with both classes' bindings and exports removed,
      and a new migration
      `{ "tag": "v5", "deleted_classes": ["SecurityCounterDO", "SecurityLedgerDO"] }`
      appended after `v4`.

   Migration tags are unique names, each applied once, in order (same legacy
   page), so `v5` can never be reused: bringing the classes back later needs a
   new tag (`v6`) with `new_sqlite_classes`.

## Destructive migrations

Mark a destructive migration (drop column, drop table, rename, `NOT NULL`
tightening) with the line `-- deploy: after-code` anywhere in its first 20
lines (`scripts/check-migrations-applied.mjs`'s `pickGateMigration` looks for
this exact line and gates on the migration before it instead — this is the
design's §2 "destructive migrations run after the code that stops using the
old shape" contract, made mechanical). Deploy the code that stops referencing
the dropped shape first; apply the after-code migration only once that code
is live and healthy.

**When applying migrations and a pending one is marked after-code, apply them
one at a time and stop before it** — `node-pg-migrate`'s `up` has no "stop
before this named migration" option, only "apply at most N pending
migrations", so `apps/api/scripts/migrate.mjs` now takes an optional 3rd
`count` argument for exactly this (#116 fix round 1, item 4):

```
DATABASE_URL="$TJ_PROD_DATABASE_URL" node apps/api/scripts/migrate.mjs dev up 1
```

Run this once per pending additive migration (checking `pgmigrations` or the
gate's own output between runs), and **do not** run a bare `up` (no count,
applies everything pending) when an after-code migration is anywhere in the
pending set — that would apply it too, before the code that still depends on
the old shape has deployed.

## Break-glass: the gate itself is blocking every deploy

The gate fails closed by design (no bypass flag), which means anything that
makes `GET /health/schema` unable to answer `200 {"applied":true}` blocks
**every** deploy to **both** Workers, including the deploy that would fix the
underlying problem. This can happen without any migration actually being
missing — for example: the `api`/`web` Worker or the database is down, a
future `app_runtime` cutover removes `SELECT` on `pgmigrations` (see the dated
note in `docs/superpowers/specs/2026-09-02-least-privilege-db-role-design.md`
§4), or `HYPERDRIVE_FRESH` itself is misconfigured.

**To get unstuck, CireSnave temporarily removes the gate, not its
guarantee:**

1. In the Cloudflare dashboard, temporarily change the affected Worker's
   build command back to just `<the CURRENT build command>` — i.e. remove
   the `node ...check-migrations-applied.mjs &&` prefix added in "The
   one-time dashboard change" above. (Or, for a single urgent deploy, run
   `wrangler deploy` manually from a trusted machine instead of going through
   Workers Builds at all.)
2. Deploy the fix for whatever is actually broken (the api, Hyperdrive, the
   DB, or the grant).
3. Confirm `GET /health/schema?migration=<a known-applied name>` answers
   `200 {"applied":true}` again from production.
4. **Restore the gate** — put the `node ...check-migrations-applied.mjs &&`
   prefix back on the build command — and confirm the next build passes it.

The script itself still has, and must keep, **no bypass flag** — this
break-glass path is a human, dashboard-level action taken deliberately and
visibly, never something the script can be told to skip through an
environment variable or argument.

## Rollback

⚠️ **Not for security alerting:** a rollback of the api across Durable Object
migration `v4` is refused by Cloudflare. Use "Security alerting: turning it off
and rolling it back" above instead.

For everything else: a manual `wrangler rollback` (or the equivalent in the Cloudflare dashboard's
Deployments view) for the affected Worker. **The migration is never
auto-reverted** (design §3 step 3: node-pg-migrate's `down` is not generally
a safe automated action, and an additive migration left in place after a
code rollback is inert, not harmful). This runbook does not add or propose
any rollback automation.

## Current order constraint

Production migrations apply in this order: **0020 → 0021 → 0022 → 0023**
(plan C → #126 → the account-legal-hold work → the keyed email reservation,
whose secret must be set first; see above). Do not apply a later one before an
earlier one in this list has landed.

## Adding a cross-script binding (web → an api Durable Object)

Workers Builds builds and deploys **both** Workers in parallel on every push to
`main`; nothing orders `api` before `web`. A web binding with `script_name:
"thinkersjournal-api"` points at a Durable Object class that must already be
**deployed** on the api Worker, i.e. after the api's DO migration that adds it.
So a change that **adds** such a binding needs one of:

1. **Two pushes:** first the api change (the class and its migration), then, once
   "Workers Builds: thinkersjournal-api" is green, the web change with the binding.
2. **One push and a retry:** if "Workers Builds: thinkersjournal-web" fails
   while the api build succeeds, read that build's log in the dashboard. If it
   names the missing class or script, use **Retry build** on the web build once
   the api build is green.

Until the web retry succeeds, production keeps serving the **previous** web
version (the failed build never deploys), and the smoke check still passes.
Seen on 15213d7 (#157): the api build succeeded and the web build failed 5 s
earlier, while `SecurityCounterDO` had not yet been deployed. The next push
(3db31a4, #158) rebuilt both Workers with the class already live, and the web
build succeeded. That is consistent with this ordering race. The build log was
not read, so it is not proven.