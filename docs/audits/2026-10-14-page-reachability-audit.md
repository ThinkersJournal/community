# Page-level reachability audit (2026-10-14)

Follow-on to #74 (endpoint-to-UI, 2026-09-20) for the need stated in #78: "the capability exists, the
path to it does not ... the gap is between pages, not endpoints."

**Static source tracing at `origin/main` 373e77f, not live execution.** A "link found" means the markup or
script exists in source; it was not clicked.

## Population

Command: `git -C C:/Projects/tjc-audit ls-files 'apps/web/src/pages'` -> **68 files** (index, not disk walk).

| Class | Count | Treatment |
|---|---|---|
| `.astro` pages | 31 | full rows below |
| `pages/api/*.ts` JSON hops | 30 | one line each (section 4) |
| Other `.ts` machine endpoints (`health/*` x3, `internal/purge`, `media-upload`, `rss.xml`, `sitemap.xml`) | 7 | section 4 |

Entry-point search scope: `apps/web/src` (pages, components, scripts, lib, middleware), `apps/api/src`
(emailed URLs), `docs/legal`. Canonical origin for emails: `https://community.thinkersjournal.com`
(`apps/api/src/auth/email-verify.ts:38`).

## Method and controls

Legend: **(N)** global nav/footer; **(L)** linked from another page/component; **(E)** emailed or token
link; **(R)** redirect after an action; **(J)** rendered by client script after hydration / only for some
viewers; **(O)** orphan.

Searches were `git grep -n -F -e "<route prefix>" -- apps/web/src` per route (plus `href=|location|Location:|
redirect(|action=` as a whole-tree sweep), and `git grep` of `apps/api/src` for `CANONICAL_ORIGIN`,
`verificationLinkOrigin`, `Url =`. Dynamic routes were searched by prefix **and** template literal
(`` `/@${...}`  ``, `` `/tag/${...}` ``, `` `/new-post?post=${...}` ``).

Note: on this box MSYS rewrites a leading `/` in a grep pattern into a Windows path, giving silent zero
hits for every query. Every search was run with `MSYS_NO_PATHCONV=1`; the first attempt without it returned
0 for all routes including `/signup`, which is how it was caught.

| Control | Result |
|---|---|
| (a) `/login` (known linked) | FOUND: `Nav.astro:26` (N, SSR default); `signup.astro:207`; `forgot-password.astro:133`; `account/delete-request/resend.astro:120`; `[handle]/[slug].astro:409`; `appeal.astro:205`, `new-post.astro:388`, `verify-email.astro:183,208` (via `?next=`); `scripts/nav-auth.ts:15,28`, `scripts/reactions.ts:32`, `scripts/social.ts:43`; redirects `feed.astro:44`, `notifications.astro:58`. Method works. |
| (b) `/new-post?post=<id>` | FOUND: post page `[handle]/[slug].astro:316` (hidden anchor `data-post-edit-link`, revealed `scripts/post-visibility-view.ts:70`); owner view `components/OwnerPostView.astro:105`; author's list on profile `scripts/owner-posts.ts:138` (template literal; the prefix `/new-post?post=` is the match); editor self-links `new-post.astro:254,454`. Method finds them. |
| (c) positive control for every ORPHAN | In section 3, beside each zero. Control query for `/notifications`: same query shape on `/authors` finds `Nav.astro:16`, `Footer.astro:13`, `feed.astro:61`. |
| (d) all-`pages/api` hops | each of the 30 hop names grepped as `"/api/<name>"` in `apps/web/src` excluding `pages/api`; 30/30 have a caller (control: `/api/me` finds `nav-auth.ts:37`). |

## 1. Page table (31 `.astro` pages)

Auth: public / session (redirects or shows login prompt) / token / Access (Cloudflare Access JWT header,
401 otherwise). Render: **C** = edge-cacheable public, **P** = per-viewer `markPrivate`.

| # | Route (file) | Auth / render / purpose | Entry points | Verdict |
|---|---|---|---|---|
| 1 | `/` (`index.astro`) | public / C / Discover listing | N `Nav.astro:14`; `404.astro:53`; `index.astro:112` | REACHABLE-BY-UI |
| 2 | `/feed` (`feed.astro`) | session / P / followee feed | N `Nav.astro:15`, `Footer.astro:12`; `404.astro:55`; `profile.href` fallback `nav-auth.ts:49`; `new-post.astro:454` | REACHABLE-BY-UI |
| 3 | `/authors` | public / C(60s) / author directory | N `Nav.astro:16`, `Footer.astro:13`; `feed.astro:61` | REACHABLE-BY-UI |
| 4 | `/tags` | public / C / tag cloud | N `Nav.astro:17` | REACHABLE-BY-UI |
| 5 | `/tag/[slug]` | public / C / tag listing | L `tags.astro:30`, `index.astro:100`, `feed.astro:88`, `[handle]/index.astro:223`, `[handle]/[slug].astro:387`, `OwnerPostView.astro:99` | REACHABLE-BY-UI |
| 6 | `/search` | public / C(60s) / posts+people | N form `Nav.astro:18`; self `search.astro:43,51-52` | REACHABLE-BY-UI |
| 7 | `/login` | public / P / sign in (`?next=`) | see control (a) | REACHABLE-BY-UI |
| 8 | `/signup` | public / P / create account | N `Nav.astro:27` (J: replaced for signed-in); L `login.astro:105` | REACHABLE-BY-UI |
| 9 | `/forgot-password` | public / P / request reset | L `login.astro:104`, `reset-password.astro:76` | REACHABLE-BY-UI |
| 10 | `/reset-password` | token / P / redeem reset | E `forgot-password.ts:138` (api) | REACHABLE-ONLY-BY-EMAIL/TOKEN (intended) |
| 11 | `/verify-email` | token+session / P / redeem token; hosts the **only** resend-verification form | E `signup.ts:414`, `resend-verification.ts:81` (api); self `verify-email.astro:227` | REACHABLE-ONLY-BY-EMAIL/TOKEN. **Not fine as designed**, see finding F1 |
| 12 | `/unsub` | token / P / one-click unsubscribe | E `email-drain.ts:120` (api) | REACHABLE-ONLY-BY-EMAIL/TOKEN (intended) |
| 13 | `/@[handle]` (`[handle]/index.astro`) | public / C / profile + owner-only drafts list | L post byline `[slug].astro:291`, comments `[slug].astro:434`, `index/feed/search/tag` bylines, `authors.astro:57`, `search.astro:78`, `settings/blocked.astro:42`, `scripts/social.ts:84`, `comments-live.ts:126`, `notificationHref` (follow) `shared/notifications.ts:173`; J own handle `nav-auth.ts:49`; R `post-delete.ts:124`, `new-post.astro:151` | REACHABLE-BY-UI |
| 14 | `/@[handle]/[slug]` (`[slug].astro`) | public / C (owner fallback P) / post + comments | L `index.astro:91`, `feed.astro:66`, `[handle]/index.astro:209`, `search.astro:65`, `tag/[slug].astro:62`; `notificationHref` bell/page/**email** `email-content.ts:18`; owner-posts `owner-posts.ts:123`; R `new-post.astro:236`, `post-visibility-view.ts:100` | REACHABLE-BY-UI |
| 15 | `/new-post` | session / P / create + edit (`?post=<id>`) | bare: N `Footer.astro:14`, J `nav-auth.ts:44`, L `index.astro:83`, `authors.astro:52`. Edit mode: see control (b); R `new-post.astro:254` | REACHABLE-BY-UI (bare); edit mode is J, see F6 |
| 16 | `/notifications` | session / P / full notification history | **none** (section 3, O1) | **ORPHAN** |
| 17 | `/settings` (`settings/index.astro`) | session / P / settings landing | J only: `scripts/nav-auth.ts:61` (client-created "Settings"); L back-link `SettingsNav.astro:25` (from its own children) | CONDITIONAL (J) |
| 18 | `/settings/notifications` | session / P / email prefs | L `settings/index.astro:34`, `SettingsNav.astro:19`, `unsub.astro:31`; E `email-content.ts:39,51` | REACHABLE-BY-UI (via J `/settings`) + E |
| 19 | `/settings/blocked` | session / P / unblock list | L `settings/index.astro:38`, `SettingsNav.astro:20` | REACHABLE-BY-UI (only via J `/settings`; see F5) |
| 20 | `/settings/account` | session / P / deletion request/cancel | L `settings/index.astro:42`, `SettingsNav.astro:21`; self `account.astro:50,107,122` | REACHABLE-BY-UI (only via J `/settings`; see F5) |
| 21 | `/account/delete-request` | token / P / barred-user deletion request | E `notice-links.ts:37` -> `notify-account.ts:63,67` (api) | REACHABLE-ONLY-BY-EMAIL/TOKEN (intended) |
| 22 | `/account/delete-request/resend` | public / P / re-mint that token link | L `account/delete-request.astro:121` only (rendered even when the token is bad); redirects none | REACHABLE-ONLY-BY-EMAIL/TOKEN (chain: needs an old link first) |
| 23 | `/appeal` | token **or** session / P / contest a decision | E `notice-links.ts:34` -> `notify-author.ts:90`, `notify-account.ts:54,58` (api). L `?post=` `new-post.astro:380` only when `hiddenAt` and `hiddenReason === "moderation"` | CONDITIONAL (see O/C notes, F4) |
| 24 | `/dsa-notice` | public / P / DSA Art. 16 intake | L `[slug].astro:376` (`?post=`), `[slug].astro:449` (`?comment=`, SSR comments only). Bare `/dsa-notice`: no link; named as text in `docs/legal/community-guidelines.md:84`, `privacy-policy.md:28` | REACHABLE-BY-UI (per item); see F7 |
| 25 | `/dsa-notice/confirm` | token / P / confirm notice | E `routes/dsa-notice.ts:139` (api) | REACHABLE-ONLY-BY-EMAIL/TOKEN (intended) |
| 26 | `/admin/queue` | Access / P / moderation queue | **none from the app**; entered by typing the URL behind Access. Inbound only from sibling admin pages `admin/appeals.astro:103`, `dsa-notices.astro:116`, `media-access.astro:95`, `accounts/[handle].astro:138` | **ORPHAN** (deliberate, O2) |
| 27 | `/admin/media-access` | Access / P | L `admin/queue.astro:105` | REACHABLE-BY-UI (admin) |
| 28 | `/admin/dsa-notices` | Access / P | L `admin/queue.astro:106` | REACHABLE-BY-UI (admin) |
| 29 | `/admin/appeals` | Access / P | L `admin/queue.astro:107` | REACHABLE-BY-UI (admin) |
| 30 | `/admin/accounts/[handle]` | Access / P | L `admin/queue.astro:122`, `admin/appeals.astro:92,130` (route comment `apps/api/src/routes.ts:448-450`: "NOT linked from the decision form ... the queue links to the account page") | REACHABLE-BY-UI (admin) |
| 31 | `/404` | public / P / not-found | framework fallback for any unmatched URL (`404.astro:53,55` are its outbound links) | REACHABLE-BY-UI (n/a) |

### Counts by verdict (31 pages)

| Verdict | Count | Rows |
|---|---|---|
| REACHABLE-BY-UI | 21 | 1-9, 13-15, 18-20, 24, 27-31 |
| REACHABLE-ONLY-BY-EMAIL/TOKEN | 6 | 10, 11, 12, 21, 22, 25 |
| CONDITIONAL | 2 | 17, 23 |
| ORPHAN | 2 | 16 (defect), 26 (deliberate) |

Rows 18-20 are counted REACHABLE-BY-UI but depend on row 17's J link; they are the F5 chain.

## 2. Entry-type tally for rows with a conditional entry

| Page | Entry type | Condition | User in other state stranded? |
|---|---|---|---|
| `/settings` | J | signed in AND JS ran AND `/api/me` answered `loggedIn` (`nav-auth.ts:37-61`) | Yes: signed-in user with JS disabled/blocked or `/api/me` failing has no link to `/settings`, `/settings/blocked`, `/settings/account` (only `/settings/notifications` via an email) |
| `/appeal?post=` | L, conditional | post hidden by a **moderator** (`new-post.astro:379`); author-hidden posts get none, deliberately (`new-post.astro:372-376` comment) | No for a moderated post: the email carries a token link too. Yes if that email was lost: the editor link is the only fallback and it is gated on `hiddenReason` |
| `/new-post?post=` | J | owner check via `/api/me` (`post-visibility-view.ts:48-70`, `owner-posts.ts`) | A JS-less author has no path to edit an existing post (cached post page ships the anchor `hidden`) |
| `/dsa-notice?comment=` | L (SSR only) | comment present at SSR render | Comments inserted live by script have no link until reload (F7) |

## 3. ORPHAN and CONDITIONAL detail

### O1. `/notifications` (`pages/notifications.astro`): ORPHAN, defect

- Exact searches (run with `MSYS_NO_PATHCONV=1`, whole index minus `docs/superpowers`):
  `git grep -n -E "href=.?[\"'\`]?/notifications|\"/notifications\"|'/notifications'|community.thinkersjournal.com/notifications"`
  -> only hits: `apps/api/src/routes.ts:315` (api route), `pages/api/notifications.ts:20` (hop),
  `notifications.astro:41,98` (self + own pager), and a test (`test/notifications-page.test.ts:12`).
  Also `git grep -F -e "/notifications" -- apps/web/src` for `Nav.astro`, `Footer.astro`,
  `scripts/notify-bell.ts`: the bell script references only `/api/notifications*` (lines 25,114,197,228,255,301)
  and its panel renders only item anchors (`notify-bell.ts:172-184`); no "see all" link. Email bodies
  (`email-content.ts`) link only the target post/profile and `/settings/notifications`.
- Positive control (same query shape, known link): `href=.?...?/authors` finds `Nav.astro:16`,
  `Footer.astro:13`, `feed.astro:61`. So zero is a real zero.
- Consequence: a user can only ever see the bell's one dropdown page of notifications; the keyset history
  (`?cursor=`) that the spec promised (`docs/superpowers/specs/2026-07-23-m2-3a-notification-core-design.md:24,120`:
  "`/notifications` page with the full keyset history") is unreachable except by typing the URL.
- Deliberate? No evidence: the spec lists the page as a deliverable; no comment or ruling removes the link.
  Likely an omission (the bell was built, the "view all" link was not).

### O2. `/admin/queue`: ORPHAN from the public app, plausibly deliberate

- Search: `git grep -n -E "/admin/queue" -- apps/web/src` hits only inside `pages/admin/*` and its own api
  fetch; `git grep -n -E "/admin/(queue|appeals|media-access|dsa-notices|accounts)" -- docs/runbooks docs/ROADMAP.md docs/legal` -> 0.
  Positive control: the same search finds `admin/queue.astro:105-107` (links to its three siblings).
- Consequence: a moderator must know and type the URL; no member-facing link exists, which is the
  point (Access gate, `admin/queue.astro:1-36` header: "no `/api/admin/*` browser-facing endpoint a member's
  session could ever reach"). Note the docs do not record the URL either (0 hits in runbooks), so it is
  tribal knowledge; low severity.

### C1. `/settings` (J): see section 2 and F5.

### C2. `/appeal` (E + conditional L): see section 2 and F4.

## 4. Machine endpoints and JSON hops (not pages)

| File | Called by | Note |
|---|---|---|
| `health/db.ts` | `scripts/deploy-smoke.mjs:80`; uptime monitor `docs/ops/uptime-monitor-spec.md:21` | monitoring |
| `health/schema.ts` | `scripts/check-migrations-applied.mjs:136` | CI |
| `health/build.ts` | named in `scripts/build-web.mjs:51` header only; no fetch call found by `git grep -F health/build -- scripts .github` | comment-only reference; not a dead hop (probe), but no caller found |
| `internal/purge.ts` | `apps/api/src/cache/purge.ts:56` | service-to-service |
| `media-upload.ts` | `scripts/media-upload.ts:33` (imported `new-post.astro:563`) | editor upload |
| `rss.xml.ts` | autodiscovery `<link rel="alternate">` only: `[handle]/[slug].astro:245`, `[handle]/index.astro:160`; self `xml.ts:153` | no visible link anywhere; see F8 |
| `sitemap.xml.ts` | **no caller found**: `git grep -n sitemap -- apps/web/src apps/web/public` finds only the generator; no `robots.txt` in index (`git ls-files | grep -i robots` -> 0; control: same listing shows `apps/web/public/favicon.svg`) | see F8 |

JSON hops (30): all have a call site. Caller per hop:

- `block`, `unblock`: `block-toggle.ts:89`, `block-toggle.ts:55`; `unblock` also `blocked-list.ts:19`.
- `blocks`: `block-toggle.ts:42`.
- `comment`, `comment-update`, `comment-delete`, `comments`: `comments.ts:150,236`, `:175`, `:191`, `:116`.
- `comments-fragment`: `comments-live.ts:259`. `posts-live`: `comments-live.ts` (WebSocket header line 3).
- `follow`, `unfollow`, `social`: `social.ts:47` (ternary), `social.ts:21,27,64`.
- `logout`, `logout-all`: `nav-auth.ts:16,29` (the #74 A-bucket `logout-all` is now wired).
- `me`: `nav-auth.ts:37`, `comments.ts:32`, `comments-live.ts:193`.
- `media-restricted`: rewritten into rendered post bodies by `lib/restricted-media.ts:32` (used by `new-post.astro:46`).
- `my-posts`: `owner-posts.ts:64`.
- `notifications`, `notifications-count`, `-read`, `-seen`, `-ws`: `notify-bell.ts:228,114,197,255,301`.
- `post-delete`: `post-delete.ts:113`. `post-hide`: `post-visibility-view.ts:90`, `post-visibility.ts:60`. `post-unhide`: `post-visibility.ts:61`.
- `react`, `unreact`, `reactions`: `reactions.ts:50`, `:82`.
- `report`: `report-control.ts:68`. `turnstile-signal`: `turnstile-error.ts:61`.

Compared with #74: its A-bucket items (`logout-all`, `reports`, `hide`/`unhide`) now each have a hop and a
call site; no B-bucket (dead hop) exists at this ref.

## 5. Final section

### 5.1 Logged-out only / logged-in only, no cross-link to the other state

| Page | State | Cross-link? |
|---|---|---|
| `/login`, `/signup`, `/forgot-password` | logged-out UI (nav slot is swapped by `nav-auth.ts:40-65` once signed in) | A signed-in user has no link to these, which is correct. A signed-in user who types `/login` gets no "you are already signed in" hint (not checked in depth) |
| `/settings*`, `/feed`, `/notifications`, `/new-post` edit | signed-in; logged-out hit `/login` redirect or login prompt (`feed.astro:44`, `notifications.astro:58`, `settings/*:22-31`, `new-post.astro:388`) | Redirect carries no `?next=` on `/feed`, `/notifications`, `/settings*` (target hard-coded `/login`), so a user who clicks the Footer "Your feed"/"Write a post" while logged out lands on `/` after login rather than where they were going. Contrast `new-post.astro:357` and `verify-email.astro:166`, which do pass `?next=` |
| Footer `Your feed` / `Write a post` (`Footer.astro:12,14`) | shown to everyone | works in both states |

### 5.2 Only entry point is a hidden/disabled element (the #78/#82 pattern)

| Target | Hidden element | Reveal | Status |
|---|---|---|---|
| `/new-post?post=<id>` on a published post | `[handle]/[slug].astro:310,316` (`.owner-actions hidden` > `a[data-post-edit-link] hidden`) | `post-visibility-view.ts:67,70`; CSS guard `.owner-actions[hidden]{display:none}` `[slug].astro:491`, global `.btn[hidden]` `global.css:34` | Works; but there are three independent routes (post page, owner view `OwnerPostView.astro:105`, profile list `owner-posts.ts:138`), so not a single point of failure. All three are J |
| `/@handle` owner drafts list | `[handle]/index.astro:244` `hidden` section | `owner-posts.ts` after owner check | J only; the editor for a **draft** (never published) is reachable only through this hidden list or by an unsaved-`?post=` URL: a draft author who reloads away has no other path (footer "Write a post" opens a blank editor). Cosmetic if JS works; stranded if not |
| `/settings` | client-created anchor (`nav-auth.ts:58-61`), not in SSR HTML at all | n/a | the one entry in the whole app that is entirely absent from server markup (F5) |
| Bell / `/notifications` | `Nav.astro:31` `data-notify-bell hidden` | `notify-bell.ts` once `/api/notifications-count` answers 200 | bell reveals correctly; it just never links onward (O1) |

### 5.3 Dead hops

None. All 30 `pages/api/*` hops have a call site (control: `/api/me`). One reference-only item:
`health/build.ts` is named only in a script header comment (section 4). `sitemap.xml.ts` is a generator
with no inbound reference.

### 5.4 Prioritised findings

| # | Severity | Finding | Evidence / fix direction |
|---|---|---|---|
| F1 | **User stranded** (high) | Resend-verification lives only on `/verify-email`, which is reachable only from the original email. `new-post.astro:366` ("Please verify your email address before posting.") and `scripts/comments.ts:84-85` ("Verify your email to comment.") give no link to `/verify-email`. A user who lost or never got the email has no UI path to the resend form. The bare URL `/verify-email` (outcome `missing`) renders the form to a session holder but nothing links to it. | search: `git grep -F -e "/verify-email" -- apps/web/src` -> only `verify-email.astro` itself (control: same shape on `/forgot-password` finds `login.astro:104`). Fix: link `/verify-email` from the two "verify your email" messages and/or the signed-in nav |
| F2 | **Feature undiscoverable** (high) | `/notifications` full history has no inbound link (O1). Bell shows one page only. | section 3, O1. Fix: "See all" link in the bell panel (`notify-bell.ts`) and/or a nav item |
| F3 | **Feature undiscoverable / stranded without JS** (medium) | `/settings` (and so `/settings/blocked`, `/settings/account`) exists only as a client-created nav link. Account deletion and the block list are therefore unreachable without JS. SSR nav carries only Sign in / Sign up. Also no Footer link. | `nav-auth.ts:58-61`; `git grep -F -e "/settings" -- apps/web/src/components` -> only `SettingsNav.astro` (its own children). Fix: add a Footer link for signed-in viewers (the Footer is cacheable-anonymous, so it needs the same J pattern or an always-visible "Settings" that redirects to login) |
| F4 | **Stranded in a narrow case** (medium) | An author whose appeal email was lost can reach `/appeal` only from the editor banner, and only for `hiddenReason === "moderation"`. A **banned** account (barred session) has no signed-in UI path to `/appeal` at all; the token email is the single route. Plausibly deliberate (the token is the authority), but the same lost-email gap as F1. | `new-post.astro:379-381`; `routes.ts:466-469` (token + signed-in paths exist in the api) |
| F5 | **Cosmetic -> medium** | Settings sub-pages are only linked from `/settings` (F3), so F3 hides three pages, not one. Sub-page `/settings/notifications` also has email entry points (`email-content.ts:39,51`; `unsub.astro:31`), so it is the one that survives. | rows 17-20 |
| F6 | **Cosmetic** | Existing-post edit link is J-only (owner check). JS-less author cannot edit a published post; three redundant J routes exist but none server-side. Intentional per `[slug].astro:310-320` ("cached, anonymous render has no viewer-specific value"). | control (b) |
| F7 | **Cosmetic** | `/dsa-notice` is linked per post/comment only; no site-wide footer link and the legal text names the URL as plain text. Comments added after hydration (`comments.ts`, `comments-live.ts`) get no "Report illegal content" link until reload: `git grep -n -i dsa -- apps/web/src/scripts` -> 0 (control: SSR `[slug].astro:376,449` has it). Also no page or footer link for the ToS / community guidelines / DMCA drafts (`git grep -i -E "terms|dmca|guidelines" -- apps/web/src` -> only the footer Privacy link `Footer.astro:24`, pointing at the marketing site). Docs say these are unpublished drafts (`docs/legal/README.md`), so deliberate for now | `Footer.astro`, `docs/legal/README.md` |
| F8 | **Cosmetic** | RSS has autodiscovery `<link>` only (no visible "RSS" link); `sitemap.xml` has no `robots.txt` pointing at it and no in-app reference. Search engines will not find it unless submitted by hand. | section 4 |
| F9 | **Cosmetic** | Auth redirects on `/feed`, `/notifications`, `/settings*` drop the destination (no `?next=`), unlike `/new-post` and `/verify-email`. | `feed.astro:44`, `notifications.astro:58`, `settings/*` `redirect("/login")` |
| F10 | **Cosmetic** | `/admin/queue` URL is documented nowhere in `docs/runbooks`; moderators must already know it. | O2 |

## 6. What could not be determined

- Live behaviour: nothing was run. "Revealed for the owner" etc. is source-level only.
- Whether Cloudflare Access is actually configured for `/admin/*` (dashboard state, not in repo).
- Whether moderation emails to **reporters** and DSA notifiers (`notify-reporter.ts`) carry any page URL;
  only `notice-links.ts` (appeal, delete-request) and the three auth/notification emails were traced.
  `routes/dsa-notice.ts:139` was traced as the only DSA confirm link.
- The shared `hiddenReason` values reaching `new-post.astro:379` were not re-derived from the api.
- `health/build.ts` caller: only a header comment was found.
- Rows were assessed one by one; none are shallow, but F9 and the "already signed in at `/login`" remark in
  5.1 were not verified beyond the cited lines.
