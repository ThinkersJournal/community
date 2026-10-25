# Moderation admin pages

For moderators. Every `/admin/*` page is behind a Cloudflare Access application scoped to
that path; without a verified Access JWT the page answers a bare 401 before any data is
fetched. Nothing in the public app links to these pages, so go by URL, on
`https://community.thinkersjournal.com`.

Start at `/admin/queue`: it links to the pages marked "from the queue", and each of those
links back to it.

| URL | Page title | Reached |
|---|---|---|
| `/admin/queue` | Moderation queue (review queue and the decision form) | by URL |
| `/admin/appeals` | Appeals | from the queue |
| `/admin/dsa-notices` | DSA notices | from the queue |
| `/admin/media-access` | Legally-held media: access requests | from the queue |
| `/admin/notices` | Undelivered notices | from the queue |
| `/admin/accounts/<handle>` | Account: @handle | from the queue and from appeals |
| `/admin/security` | Security | by URL (it links back to the queue; the queue does not link to it) |

If a page answers 401 for a moderator, the Access application or the moderator's policy is
missing in the Cloudflare dashboard (dashboard state, not code).
