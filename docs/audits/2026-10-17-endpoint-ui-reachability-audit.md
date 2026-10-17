# Endpoint-to-UI reachability audit, refresh (2026-10-17)

Refresh of #74 (first run 2026-09-20, 62 routes, 13 in bucket A). Read-only: this audit fixes nothing.

**Static source tracing at `origin/main` 4821c4c, not live execution.** "A call site exists" means the code is
in source and is reached from a page or script; nothing was clicked.

## Population

`apps/api/src/routes.ts` registers **104 routes** (`grep -c 'pattern: "'` = 104; the parser below recovered
104 of 104, so no route was dropped). The first run had 62. Taken from the route table itself, never a
hand-picked list.

## Method

1. Parse every `(method, pattern)` out of `routes.ts` (both the one-line and the multi-line object forms).
2. Extract every path literal passed to `apiFetch`, `adminApiFetch` or `API.fetch` in the 123 files returned
   by `git ls-files apps/web/src` (index, not a disk walk): 114 call expressions.
3. Match each literal against each route pattern (`:param` as one segment). A route with no match is
   resolved by hand: the 15 that matched nothing were each read (see "Resolved by hand").
4. For every browser-facing hop (`pages/api/*.ts`, `media-upload.ts`) find a non-comment caller in
   `apps/web/src/scripts` or a page (bucket B test). Hops that appear only in comments do not count.

Buckets as in the first run: **A** no browser path, **B** hop exists and nothing calls it, **C** a page or
script calls it, **D** deliberately no UI.

## Controls

| Control | Expected | Found |
|---|---|---|
| `DELETE /posts/:id` | C | C: `scripts/post-delete.ts:113` posts `/api/post-delete` |
| `POST /posts/:id/hide`, `/unhide` | A in the first run (#73), C now | C: `scripts/post-visibility.ts:60-61`, `post-visibility-view.ts:90` |
| A route with no caller | must be reported | `POST /admin/backfill-hidden-media` reported (bucket D, below) |

## Result

| Bucket | Count | Routes |
|---|---|---|
| A | **0** | none. All 13 of the first run's A routes now have a caller |
| B | **0** | every `pages/api` hop and `media-upload` has a non-comment caller |
| D | **15** | `GET /health`, `/health/build`, `/health/schema`, `/health/db`, `/health/security-ledger`; `POST /admin/backfill-hidden-media`; the 9 `/__test/*` routes |
| C | **89** | everything else |

Movement since 2026-09-20 (the 13 former A routes): `POST /auth/logout-all` (`scripts/nav-auth.ts:29`),
`POST /posts/:id/hide` and `/unhide`, `POST /reports` (`scripts/report-control.ts:68`), `POST /blocks` and
`DELETE /blocks/:blockedId` (`scripts/block-toggle.ts`), `GET /media/restricted/:sha256`
(`lib/restricted-media.ts:32` rewrites a hidden post's image URLs to `/api/media-restricted`), and the six
original `/admin/*` routes (all now have `apps/web/src/pages/admin/*.astro` pages).

### Bucket D, with the reason

- `GET /health`, `/health/db`, `/health/build`, `/health/schema`, `/health/security-ledger`: monitor and deploy
  smoke targets. `pages/health/*.ts` are the web Worker's own endpoints (`build` is not a proxy).
- `POST /admin/backfill-hidden-media`: no web caller. The same work runs from the `*/2` cron
  (`src/index.ts` -> `runOneBatch`); the route is the manual re-run for an operator with an Access token.
- `/__test/*` (9): `TEST_ROUTES`-gated, unset in production, used only by `apps/api/test` and e2e.

### Resolved by hand (matched no literal)

| Route | Caller |
|---|---|
| `GET /feed`, `GET /notifications`, `GET /public/discover`, `GET /public/authors` | `feed.astro:27`, `notifications.astro:40`, `index.astro:38`, `authors.astro:32` (path or query held in a variable) |
| `PATCH /comments/:id`, `DELETE /comments/:id` | `scripts/comments.ts:194,210` through the `comment-update` / `comment-delete` hops (path built as `"/comments/" + id`) |
| `POST /account/delete`, `/account/delete/cancel` | `settings/account.astro:37` (`endpoint` chosen by form action) |
| `GET /public/followers`, `/public/following` | `scripts/social.ts:64` (`/api/social?list=`), hop builds `/public/${list}` |
| `POST /appeals`, `POST /appeals/by-token` | `appeal.astro:70` (chosen by `signedIn`) |
| `GET /health`, `GET /health/build` | not called through `apiFetch`; see bucket D |

## What this audit does not show

- It does not show a path **works**. A call site in source says the control exists, not that it behaves.
- It does not check that a control is **visible to the right viewer** (that is the page-level audit,
  `2026-10-14-page-reachability-audit.md`).
- `/api/turnstile-signal` is a web-only beacon with no api route behind it; it is outside the 104.
- Hops were matched by string. A hop referenced only through a computed URL would be reported as B; none was.

## Follow-ups

None required by the result. Bucket A and B are empty at this ref.
