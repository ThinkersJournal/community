# Register the GitLab OAuth application (M3.6) — about 5 minutes, once

**Who:** CireSnave. **No agent registers this.** gitlab.com only; public resources only; minimum scope. Not needed before M3.3
(GitHub) ships; do it any time before M3.6. GitLab's labels change; match on meaning if one differs and tell the PM.

## 1. Create it
1. gitlab.com → your avatar → **Edit profile** → **Applications** → **Add new application**.
   (If a `ThinkersJournal` group owns the project, use the group's **Settings → Applications** instead.)
2. Fill in exactly:

| Field | Value |
|---|---|
| Name | `Thinkers Journal Community` |
| Redirect URI | `https://community.thinkersjournal.com/api/connectors/gitlab/callback` |
| Confidential | **checked** |
| Trusted | **unchecked** |
| Scopes | **`read_api`** only (nothing else ticked) |

3. Click **Save application**.

The Redirect URI is the path M3.6 will serve. It is only a reservation; GitLab lets you edit it later, so if the lane picks a
different path the PM will ask you for a one-field edit.

## 2. Where things go
**Only the client Secret is a secret.** The Application ID is public (it is in every authorize URL), and `with-secret` refuses
values under 12 characters anyway, so the ID does NOT go in the vault. Never put the Secret in a repo, a PR, chat or an issue.
GitLab shows the **Application ID** and the **Secret** once on the saved page; copy both now.

| What | Where | Name |
|---|---|---|
| the Secret | the vault, then a Worker secret | vault `GITLAB_TJCOMMUNITY_CLIENT_SECRET`, `--env GITLAB_CLIENT_SECRET`; Worker secret `GITLAB_CLIENT_SECRET` (`wrangler secret put GITLAB_CLIENT_SECRET --name thinkersjournal-api`) |
| the Application ID | a plain Worker var, committed in `apps/api/wrangler.jsonc` `vars` | `GITLAB_CLIENT_ID` |

Store the Secret with `with-secret vault set GITLAB_TJCOMMUNITY_CLIENT_SECRET --env GITLAB_CLIENT_SECRET --access read` and a
`--rotate-by` date. The PM sets the Worker secret at deploy. The Application ID goes in the M3.6 PR that adds the `vars` entry
(CireSnave tells the PM the number in chat; it is not sensitive).

## 3. Tell the PM
"GitLab app registered." The Application ID may follow in the same chat message (it is public); never the Secret.

## Notes for the lane (not for CireSnave)
- `read_api` is the narrowest scope that reads issues, merge requests, files and pipelines; GitLab has no read-only-public-only
  scope. Public-only is enforced by our connector (it refuses a resource that is not publicly visible). Re-check the scope list at
  M3.6 and narrow it if GitLab offers something smaller.
- Budget: the plan sizes for GitLab's proposed per-plan limits, not today's; see the plan's source table.
