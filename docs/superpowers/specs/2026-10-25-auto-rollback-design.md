# Automatic rollback after a failed post-deploy check (S15 b)

**Status:** built (inert until the token below exists). 2026-10-25. Rulings: CireSnave, board 287 via the PM: (a) the
migration gate is on the Cloudflare build command, confirmed; (b) **automate rollback** (option B). Not legal or
security advice. Companion to `2026-09-27-deploy-automation-design.md` section 3, which this implements.

## 1. What it does

`.github/workflows/prod-smoke.yml` already smoke-checks production 90 seconds after every push to `main`. A new `rollback`
job runs **only after a push whose smoke check failed**:

1. **Re-check.** Three tries, a minute apart. If production answers, nothing happens (one blip must not roll production back).
2. **Guard.** If the push changed `apps/api/wrangler.jsonc` or `apps/web/wrangler.jsonc`, it stops and says so: a Durable Object
   class lifecycle change makes Cloudflare refuse a rollback across it (`docs/runbooks/deploy.md`, "Security alerting: turning it
   off and rolling it back"), so a person does that one.
3. **Roll back** `thinkersjournal-api`, then `thinkersjournal-web`, each to the deployment before its current one, at 100%
   (`scripts/auto-rollback.sh`, curl and jq against Cloudflare's Deployments API; no wrangler, no `pnpm install`, so a broken
   build cannot stop it). A Worker with no earlier deployment, a gradual (split) deployment, or a rollback Cloudflare refuses is
   reported and left alone, and the job ends red.
4. **Verify** production with the same smoke script, then **open an issue** saying what happened and whether production is healthy.

It never runs on the 15-minute schedule (a failure with no code change behind it is not a bad deploy), and it never touches the
database: a rolled-back code version leaves its migration in place, which is inert because migrations are additive by rule
(design `2026-09-27` section 3, step 3). After a rollback `main` is **ahead** of what is deployed; the issue says so, and the next
push redeploys.

## 2. Why this is safe to leave unattended

| Risk | Answer |
|---|---|
| A flaky check rolls back a good deploy | three tries, a minute apart, before anything moves |
| Rolling back across a Durable Object change | a changed `wrangler.jsonc` stops the job; Cloudflare would refuse it anyway, and the script reports a refusal rather than retrying |
| A rollback loop | a rollback is not a push, so it triggers nothing; the job has a `concurrency` group |
| Two Workers on different versions | both are rolled back; one refusal does not strand the other on the bad version, and is reported |
| The rollback itself breaks production | the job re-checks production afterwards and goes red if it is still failing |
| Nobody notices | the run is red, and an issue is opened (GitHub notifies the repository's watchers; the wider alert channel is S15 c, still open) |

## 3. The credential, plainly

A token that can change what the production Workers run is **the second most powerful secret the project holds**, after the
database owner's. Cloudflare has no "roll back only" permission: the smallest token that can create a deployment is **Workers
Scripts: Edit** on the account, which can also deploy *arbitrary code* to any Worker in it, and code in a Worker can read that
Worker's runtime secrets. CireSnave chose this (option B); these are the controls that keep it as small as it can be:

- **A dedicated token**, used by nothing else, with exactly one permission: *Account · Workers Scripts · Edit*, on this one
  account. No zone, no DNS, no R2, no database.
- **A GitHub Environment secret, not a repository secret.** The Environment `production-rollback` is limited to the `main`
  branch, so a pull request, a fork or any other branch cannot read it. `main` accepts changes only through a pull request with
  the required checks (branch protection), so a change to this workflow, or to `scripts/auto-rollback.sh`, is reviewed before it
  can run with the token. The job grants itself only `contents: read` and `issues: write`.
- **Only the one step that needs it sees it.** The token is in that step's environment alone; it is never echoed (the script's
  test asserts the log never contains it), and actions are pinned by commit.
- **The account id is a variable**, not a secret.

### What CireSnave creates (about ten minutes, in this order)

1. **GitHub, first:** repository *Settings, Environments, New environment* named exactly `production-rollback`. Under
   *Deployment branches and tags* choose *Selected branches and tags* and add `main`. **Do this before adding the secret**
   (referencing an Environment that does not exist creates it with no restriction).
2. **Cloudflare:** *My Profile, API Tokens, Create Token, Create Custom Token*. Name it `tj-ci-rollback`. Permissions: *Account,
   Workers Scripts, Edit*. Account Resources: *Include, the Thinker's Journal account only*. (Optional: a Client IP Address
   Filtering rule is not practical for GitHub-hosted runners, whose addresses change. Set a TTL of one year.) Copy the token once.
3. **GitHub, in the `production-rollback` Environment:** add the *secret* `CLOUDFLARE_API_TOKEN` (the token) and the *variable*
   `CLOUDFLARE_ACCOUNT_ID` (the account id, from the Cloudflare dashboard's right-hand column).
4. Nothing else. Until step 3 is done the job prints "Automatic rollback is not configured" and exits without acting.

**Rotate** the token yearly (create a new one, replace the secret, delete the old). **Revoke** it at once in the Cloudflare
dashboard if the repository's settings, the workflow or the token are ever suspected of exposure; the rollback is then manual
(`docs/runbooks/deploy.md`, "Rollback") until a new token is set.

## 4. What it does not do

- It does not revert a migration, and it does not run one (the database credential stays out of CI: design `2026-09-27` section 4).
- It does not roll back across a `wrangler.jsonc` change, a split deployment, or when there is no earlier deployment.
- It does not decide the alert channel for pipeline failures (S15 c).
- It does not replace a human reading the issue: `main` is ahead of production until someone fixes forward or reverts.

## 5. Tests and how to try it

`apps/api/test/auto-rollback-script.node.test.ts` runs the script against a fake Cloudflare API: the order and body of the calls,
`DRY_RUN=1`, a missing earlier deployment, a Cloudflare refusal, a split deployment, a missing token, and that the token never
reaches the log. The workflow job itself has not been run against Cloudflare (the token does not exist yet), and its first live run will be a
real failure. Until then, with the two variables set in a local shell, `DRY_RUN=1 bash scripts/auto-rollback.sh` lists what it
*would* roll back on the real account without changing anything: do that once after the token is created, before relying on it.
