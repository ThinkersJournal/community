# Deploy Automation — Design (spec only, not built)

**Status (2026-10-01):** option 2 BUILT as shape A (no credential) — docs/runbooks/deploy.md; auto-rollback (§3 step 2) deferred to a future deploy-credential design.

**Status:** Design for founder/PM review. **Detection is proven** (see
`.github/workflows/prod-smoke.yml` / `scripts/smoke-prod.sh`, verified 2026-09-27
to both fire and correctly fail) — that was the stated precondition for this
design work, not for implementation. **Nothing in this document is built.** No
credential of any kind has been added anywhere as part of it.

**Author:** Community controller agent, 2026-09-27, dispatched by the portfolio
PM after the 2026-09-27 production incident (see below).

**Grounding — the incident this design exists to prevent from repeating:**
migration `0019_account_deletion.sql` (additive: two new nullable columns) was
merged and its dependent code (#107) shipped and auto-deployed to production
within ~1 minute of merge (Cloudflare's own git-integration build/deploy, not
anything in this repo's CI). The migration itself was never run against the
production database — nothing in the current pipeline ties "migration exists"
to "migration has been applied." Every query referencing the new column threw
at request time; four public routes (`/`, `/authors`, `/rss.xml`,
`/sitemap.xml`) served bare, empty-body 404s for hours before an unrelated
audit noticed. **The defect class is a step that works with no mechanism
ensuring it runs** — the same shape as `docs/ops/uptime-monitor-spec.md`
describing a check that may never have been stood up, and as M4 module 2c
(`docs/superpowers/specs/2026-09-06-m4-moderation-queue-design.md`) describing
an enforcement ladder with no code path that ever fires it (issue #113). This
design closes the deploy-time instance of that pattern; it does not touch the
other two.

---

## 1. What's live today (established fact, not assumption)

- **Cloudflare's own git integration** (Workers Builds) deploys `main` on every
  push, automatically, in roughly one minute. Confirmed directly: `GET
  /health/build` reported `sha: 7e15425` at `2026-09-26T22:34:17Z`, one minute
  after that commit's merge.
- **Migrations are a separate, manual, founder-executed step.** `apps/api/scripts/migrate.mjs`
  reads `DATABASE_URL` for anything other than its `test` target, with a
  **localhost fallback** — there is no `prod` target in the script at all
  today. The production connection string lives on CireSnave's machine as
  **`TJ_PROD_DATABASE_URL`**, deliberately NOT named `DATABASE_URL`, specifically
  so that `npm run migrate` (or any agent running it) cannot silently reach
  production. **This design must not weaken that property.**
- **Nothing verifies a deploy after it lands.** `scripts/smoke-prod.sh` +
  `.github/workflows/prod-smoke.yml` (merged 2026-09-27) now check the live site
  periodically and on-demand, but nothing today runs it *as a deploy gate*, and
  nothing today can act on its result.

This means the current pipeline has exactly one automated step (code deploy)
sitting between two manual ones (migration, verification) with no ordering
guarantee between any of them. Tonight's incident is what that produces.

---

## 2. The migration step, and why ordering is the whole design

**Rule: expand before contract, always, and CI is what enforces the ordering
that a human previously had to remember.**

- **Additive migrations (new nullable column, new table, new index) run
  BEFORE the code that depends on them deploys.** Old code never references
  the new column/table, so it is unaffected by its existence — this is what
  makes the migration safe to run first. Code that *reads* the new column
  only ships once the column is guaranteed to exist.
- **Destructive migrations (drop column, drop table, rename, `NOT NULL`
  tightening) run AFTER the code that stops referencing the dropped thing has
  deployed and been verified healthy.** This repo already documents this
  exact discipline by hand in at least two places — `0011_drop_username_chosen.sql`'s
  own migration comment, and the handle-at-signup design doc's *"Deploy
  ordering: deploy the code that no longer references the column first, then
  run `0011`"* — this design turns that existing, correctly-understood-but-manual
  rule into something a pipeline enforces rather than something a human must
  remember on every future migration.
- Tonight's incident was the additive case, inverted: the code that *reads* a
  new column shipped **before** the column existed anywhere outside `main`.
  A pipeline that ran the migration before (or atomically with) the code
  deploy would have prevented it outright — the code would have had a real
  column to query from the moment it went live.

**Proposed step order for an additive migration + its dependent code:**

1. CI applies the migration(s) that are new since the last deploy, against
   production, using the mechanism in §4.
2. CI verifies the migration succeeded (a real check — e.g. re-query
   `pgmigrations` for the new migration's row, not just a zero exit code; see
   the portfolio's own "an exit code is not a state read" rule).
3. Cloudflare's deploy proceeds (or CI explicitly triggers it — see §5) only
   after step 2 confirms.
4. Post-deploy verification (§3) runs against the now-live code.

**For a destructive migration**, the same pipeline runs in the opposite
relationship: the code deploy (and its post-deploy verification) must
complete and be confirmed healthy *first*; the destructive migration is a
**separate, later** pipeline run, never bundled into the same deploy that
stops referencing the dropped object. This is deliberately NOT symmetric with
the additive case, and a generic "always migrate-then-deploy" step order
would get the destructive direction wrong — the pipeline needs to know which
kind of migration it's running, or default to treating every migration as
requiring the safer (post-deploy) ordering unless explicitly marked additive.

---

## 3. Post-deploy verification — what happens on failure, stated explicitly

Reuse `scripts/smoke-prod.sh` exactly as it exists (six routes, 200 + non-empty
marker body, not just a status code) — it was purpose-built and proven
tonight; do not build a second verification mechanism.

**On success:** the pipeline reports green and stops. Nothing further happens
— this is the boring, common case.

**On failure**, in order:

1. **Fail the pipeline loudly** — the same discipline `prod-smoke.yml`
   already has (non-zero exit reddens the run, visible in Actions + GitHub's
   own failure notifications). A deploy pipeline that "deploys and then
   notices nothing" is tonight's incident with extra steps, which is the
   exact thing this design exists to not be.
2. **Roll back the CODE deploy** to the immediately-prior Cloudflare
   deployment (`wrangler rollback`, or the equivalent Deployments-API call).
   This is why §2's ordering discipline matters here too: a code-only
   rollback is safe *only* if the migration that ran alongside it was
   additive (old code never referenced the new column, so reverting to old
   code while the new column still exists is harmless) — which is exactly
   the case this design's ordering rule produces. Rolling back code after a
   *destructive* migration is a different, harder problem (the old code may
   reference a column that's now gone) — which is precisely why §2 forbids
   bundling a destructive migration into the same deploy as the code that
   still needs the old shape.
3. **Do NOT attempt to auto-revert the migration.** Migrations are not
   generally safely reversible in an automated failure path (a `down`
   migration can lose data, and node-pg-migrate's `down` here reverts the
   *entire* stack past one file in some of this project's own test tooling —
   see `migrations.db.test.ts`'s own comments on why `count: Infinity` was
   needed for a correct round-trip test). An additive migration that already
   ran and is now unused by the rolled-back code is inert, not harmful —
   leave it in place and let the next attempt at the code deploy pick it up
   again.
4. **Notify a human.** Same "fail loudly" principle as `prod-smoke.yml` —
   this needs to actually reach CireSnave, not just exist as a red check
   nobody is subscribed to. This document does not choose the channel; that's
   the same open question `docs/ops/uptime-monitor-spec.md` already has
   (mobile push via UptimeRobot/Better Stack, per that spec) and is out of
   scope here — but whatever channel gets chosen for uptime alerts should
   almost certainly also carry deploy-pipeline failures, since they're the
   same "someone needs to look at this now" class of event.

---

## 4. The credential — stated plainly, because this is CireSnave's decision, not an engineering detail

**Running migrations from CI means a production database credential exists
in CI.** There is no way to automate the migration step without this. Naming
it plainly rather than routing around it:

- **What access is needed:** a role that can run arbitrary DDL — `CREATE
  TABLE`, `ALTER TABLE`, `DROP COLUMN`, `CREATE INDEX`, everything every
  migration file in `apps/api/migrations/` does. This is **not** something
  `app_runtime` (the least-privilege role from
  `2026-09-02-least-privilege-db-role-design.md`, if it's ever cut over) can
  do — that design deliberately scopes `app_runtime` to DML only, and its own
  §2.5 explicitly notes migrations stay on `neondb_owner` *because* the
  runtime role must never hold schema-changing privileges. **A least-privilege
  role does not suffice for this step, by the existing design's own
  reasoning — this needs something close to `neondb_owner`, or a dedicated
  migration-only role with equivalent DDL rights (which is itself
  `neondb_owner`-equivalent in blast radius, just narrower in name).**
- **What it could do if leaked or misused:** everything. A DDL-capable
  credential can drop any table, alter any column, read or corrupt any row
  via a crafted migration file, or grant itself further access. This is the
  highest-privilege credential this project has, full stop — there is no
  scoped version of "can run migrations" that isn't also "can do anything to
  the schema and, transitively, the data behind it."
- **The `TJ_PROD_DATABASE_URL` naming discipline must carry into CI
  unchanged.** The property that makes the current setup safe is that
  `migrate.mjs`'s only production-reachable env var (`DATABASE_URL`) is
  simply never set to the production value anywhere an agent's ordinary
  invocation would pick it up. The CI equivalent: the production DDL
  credential must be stored under a name that is **not** `DATABASE_URL`,
  **not** anything `migrate.mjs` would read by default, and ideally gated as
  a GitHub **Environment secret** (scoped to a `production` environment with
  required reviewers) rather than a repository-level secret every workflow
  run can read. A repository secret is available to any workflow on any
  branch by default; an Environment secret can be restricted to specific
  branches and require a human approval click before the job that reads it
  runs — that approval click is the CI-native equivalent of "CireSnave
  personally decided to run this."
- **This is explicitly his call to make, not a default this design assumes.**
  The options, undecided here:
  1. Grant a DDL-capable CI credential (accepting the blast radius above,
     mitigated by GitHub Environment protection rules).
  2. Don't automate the migration step at all — CI prepares/validates the
     migration (dry-run against a scratch database, confirms it's the next
     pending one) and prints the exact command for CireSnave to run by hand,
     the same trust boundary as today, just with better guardrails around
     the manual step. This gets most of the safety of §2's ordering
     discipline (CI can still refuse to deploy code until it detects the
     migration has landed) without ever holding the credential.
  3. A middle path: a short-lived, narrowly-scoped credential minted per-run
     (if Neon's API supports temporary/scoped credentials) rather than a
     long-lived secret sitting in GitHub indefinitely.

  Option 2 is the one that changes nothing about today's trust model while
  still fixing tonight's actual defect (nothing checked whether the
  migration had run before the code that needed it shipped) — CI can refuse
  to let the code deploy proceed until it observes the migration's row in
  `pgmigrations`, without CI ever being the thing that ran it. Worth strong
  consideration precisely because it needs no new production credential at
  all.

---

## 5. GitHub Actions vs. Cloudflare's own git integration — reasoning, not assumption

**Recommendation: move deploy invocation into a GitHub Actions workflow;
disable (or stop relying on) Cloudflare's automatic git-triggered build.**

Cloudflare's git integration deploys on push with no hook point this repo
controls for "run a migration first" or "verify after, and roll back on
failure." It is a black box from this repo's point of view — auditable only
in the Cloudflare dashboard, not in a reviewable PR diff. Tonight's incident
is a direct consequence of that: the deploy happened, instantly, with no
opportunity for anything to check that its precondition (the migration) had
been met.

Moving deploy invocation into a workflow file (`wrangler deploy`, called
explicitly, as its own step) means:
- The migration-check gate from §2 can sit *before* it in the same job.
- The smoke-check gate from §3 can sit *after* it in the same job, with a
  real rollback action wired to its failure.
- The whole pipeline — migration check, deploy, verify, rollback-on-failure —
  is one YAML file in this repo, reviewable in a PR, with its history in git
  rather than in a dashboard's audit log.

This is a bigger change than it might look — it means turning off (or
ignoring) whatever is currently driving the ~1-minute auto-deploy, which is
itself a live production behavior change and should be sequenced carefully
(confirm the GitHub Actions path fully replaces it, including that build
step's own guards — e.g. `scripts/build-web.mjs`'s Turnstile-key deploy
guard — before disabling Cloudflare's own trigger, so there's no gap where
neither pipeline is actually deploying anything).

---

## 6. Deploy-to-preview-then-promote — is it worth the complexity here?

**My actual recommendation: not yet.** This is a two-Worker, solo-founder
project with (per tonight's own finding) effectively zero production content
and no evidence of concurrent contributors landing conflicting deploys. A
preview-then-promote model (deploy to a staging URL, run the smoke check
against *that*, then explicitly promote to production) buys real safety at
real cost: a second live URL to keep configured identically to production
(same bindings, same Hyperdrive targets or safe equivalents), a promotion
step that's one more manual or automated action to get right, and — the
sharpest edge — a preview environment that talks to the SAME production
database (Hyperdrive bindings aren't easily forked per-preview without
either a second Neon branch or accepting the preview writes real prod rows)
undermines the whole point of a preview, while a preview pointed at a
*different* database can't actually prove the migration-plus-code pairing
this design is about.

The linear pipeline in §§2-3 (migrate-check → deploy → smoke-check →
rollback-on-failure) closes tonight's actual gap without any of that
complexity. Preview-then-promote becomes worth revisiting if/when: real
traffic makes a bad deploy's blast radius large enough that a few minutes of
smoke-check-then-rollback isn't fast enough, multiple people are shipping to
`main` concurrently, or Neon's branching makes a true per-preview database
cheap enough that the database problem above goes away. None of those are
true today.

---

## 7. Summary of what this design does and does not decide

**Decided (recommended, not yet built):**
- Expand-before-contract ordering, enforced by the pipeline rather than
  remembered by a human, with additive and destructive migrations sequenced
  oppositely relative to their code deploy.
- Reuse `scripts/smoke-prod.sh` unchanged as the post-deploy gate; on
  failure, roll back the code deploy (never the migration) and fail loudly.
- Move deploy invocation from Cloudflare's git integration into a GitHub
  Actions workflow, so the migration-gate and smoke-check-gate have a place
  to sit.
- Skip preview-then-promote for now; named the conditions under which that
  changes.

**Explicitly left to CireSnave (§4):** whether CI ever holds a DDL-capable
production credential at all, or whether the migration step stays manual
(recommended default: stays manual, gated by a CI check that the migration
already landed, per option 2) with everything else in this design still
applying around it.

**Not built, not started, no credential added:** this entire document is a
plan. Implementation is a separate, later piece of work, gated on the
decision in §4.
