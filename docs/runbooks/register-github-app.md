# Register the GitHub App (M3.3) — about 10 minutes, once

**Who:** CireSnave (the account that owns it). **No agent registers this.** Public repositories only; read-only; no webhook yet.
GitHub's page labels change now and then; if one differs from below, match on the setting's meaning and tell the PM.

## 1. Create it
1. github.com → your avatar → **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**.
   (If the `ThinkersJournal` organisation should own it, do this from the organisation's Settings instead.)
2. Fill in exactly:

| Field | Value |
|---|---|
| GitHub App name | `Thinkers Journal Community` (if taken, add `-refs`; the name is not used in code) |
| Description | `Reads public GitHub issues, pull requests, files and CI checks so a post can show them live.` |
| Homepage URL | `https://community.thinkersjournal.com` |
| Callback URL | leave **empty** |
| Expire user authorization tokens | leave as is (unused) |
| Request user authorization (OAuth) during installation | **unchecked** |
| Setup URL | leave empty |
| Webhook → **Active** | **unchecked** (no webhook URL or secret now; the engine polls by ETag) |
| Where can this GitHub App be installed? | **Any account** |

## 2. Permissions (Repository permissions; everything else stays *No access*)
| Permission | Access |
|---|---|
| Metadata | Read-only (forced on) |
| Contents | **Read-only** (file and line range) |
| Issues | **Read-only** |
| Pull requests | **Read-only** |
| Checks | **Read-only** (CI check runs) |

No Account permissions. No Organization permissions. **Subscribe to events:** none.

## 3. Finish
1. Click **Create GitHub App**.
2. On the app's page, copy the **App ID** (a number).
3. Scroll to **Private keys** → **Generate a private key**. A `.pem` file downloads. This is the only copy GitHub will give you.
4. Left menu → **Install App** → install it on your own account, choosing **Only select repositories** and picking one repo (any).
   The app mints its tokens through this installation. Our public-only reads need no access to other people's repos.

## 4. Where things go
**Only the private key is a secret.** The App ID is public (it is on the app's page and in its install URLs), and `with-secret`
refuses values under 12 characters anyway, so it does NOT go in the vault. Never put the key in a repo, a PR, chat or an issue.

| What | Where | Name |
|---|---|---|
| the whole `.pem` text | the vault, then a Worker secret | vault `GITHUB_TJCOMMUNITY_APP_PRIVATE_KEY`, `--env GITHUB_APP_PRIVATE_KEY`; Worker secret `GITHUB_APP_PRIVATE_KEY` (`wrangler secret put GITHUB_APP_PRIVATE_KEY --name thinkersjournal-api`) |
| the App ID | a plain Worker var, committed in `apps/api/wrangler.jsonc` `vars` | `GITHUB_APP_ID` |

Store the key with `with-secret vault set GITHUB_TJCOMMUNITY_APP_PRIVATE_KEY --env GITHUB_APP_PRIVATE_KEY --access read` and a
`--rotate-by` date, then delete the downloaded `.pem`. The PM sets the Worker secret when M3.3 reaches deploy. The App ID goes
in the M3.3 PR that adds the `vars` entry (the PM tells the lane the number in chat; it is not sensitive). A var in the file
cannot drift, and a dashboard edit would be reset by the next deploy, so change it in the file.

## 5. Tell the PM
"GitHub App registered." The App ID may follow in the same chat message (it is public); never the key.

## Notes for the lane (not for CireSnave)
- Assumption to confirm in M3.3's first build: an installation token reads public repositories outside the installation. If it
  does not, the fallback is unauthenticated reads (60 requests/hour per IP), which the plan's budget cannot carry; we would then
  ask for a different install scope. Raised now so it is not a surprise.
- Rate figures and ETag behaviour: `docs/superpowers/plans/2026-10-25-m3-reference-engine-plan.md`, source table.
