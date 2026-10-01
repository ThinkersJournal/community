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

## The one-time dashboard change (CireSnave)

For **each** Worker — `thinkersjournal-web` and `thinkersjournal-api` — open
its Cloudflare Workers Builds settings and change the build command to:

```
node scripts/check-migrations-applied.mjs && <the CURRENT build command>
```

The current build commands live only in the Cloudflare dashboard — they are
**not** in this repo (see `apps/api/src/routes/health-build.ts`'s own header
for why the `api` Worker in particular has no build script here to hook
into). **Keep whatever is there today after the `&&`; don't guess it.**

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

1. **Merge.** The next build (either Worker, whichever one's dashboard
   command has the gate wired in) **fails at the gate** — this is expected,
   not a regression. The gate's own log line says which migration is missing:

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

   ```
   DATABASE_URL="$TJ_PROD_DATABASE_URL" node apps/api/scripts/migrate.mjs dev up
   ```

   Run from a trusted machine, with the credential supplied inline on the
   command line (never written to a file, never exported into a shell
   profile, never stored).

3. **Retry the build** in the Cloudflare dashboard. The gate now sees
   `{"applied":true}` and the build proceeds — the deploy ships.

4. **`prod-smoke.yml` runs after the push**, as it already does for every
   push to `main` (unchanged by this work — see that workflow).

## Destructive migrations

Mark a destructive migration (drop column, drop table, rename, `NOT NULL`
tightening) with the line `-- deploy: after-code` anywhere in its first 20
lines (`scripts/check-migrations-applied.mjs`'s `pickGateMigration` looks for
this exact line and gates on the migration before it instead — this is the
design's §2 "destructive migrations run after the code that stops using the
old shape" contract, made mechanical). Deploy the code that stops referencing
the dropped shape first; apply the after-code migration only once that code
is live and healthy.

## Rollback

A manual `wrangler rollback` (or the equivalent in the Cloudflare dashboard's
Deployments view) for the affected Worker. **The migration is never
auto-reverted** (design §3 step 3: node-pg-migrate's `down` is not generally
a safe automated action, and an additive migration left in place after a
code rollback is inert, not harmful). This runbook does not add or propose
any rollback automation.

## Current order constraint

Production migrations apply in this order: **0020 → 0021 → 0022** (plan C →
#126 → the account-legal-hold work). Do not apply a later one before an
earlier one in this list has landed.
