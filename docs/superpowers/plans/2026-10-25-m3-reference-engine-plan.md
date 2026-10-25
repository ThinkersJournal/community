# M3 — the live-reference engine: plan

**Status:** PLAN, 2026-10-25. Nothing in this plan is built. Source of the ruling: CireSnave, board 287 item S1, option b, via the PM
(task of 2026-10-25): **launch is held until the M3 live-reference engine exists.** The design it implements is
`docs/superpowers/specs/2026-07-13-community-platform-design.md` (Pillar B; decisions 3, 6, 17, 22; the M3 line of the build
sequence), and this plan changes none of those decisions. Where this plan states an external fact (a rate limit, a term), it names
the page it was read from on 2026-10-25; a fact marked **unverified** was not read from the source and must be before it is relied on.

## 1. Where we are

M3 has no code, no migration and, until the spec-to-roadmap audit (ROADMAP S1), had no roadmap row. M0 (foundations), M1 (publishing
and the public web), M2 (social) and the M4 safety work that is built are live or merged. The README tagline advertises references.
`posts.markdown_source` already reserves the `{{ref:TOKEN}}` placeholder syntax (design, data model), and `packages/markdown`
renders at read time, so the render side has a place to plug in.

## 2. Scope

**In (the launch set, design decision 6):** GitHub (file and line range, CI check, pull request, issue), GitLab (the same kinds),
generic web links (an OpenGraph unfurl), YouTube, X. Authoring is paste-a-URL-to-enrich plus an `@` / slash picker. The engine is
**hybrid**: a snapshot captured at post time that always renders, plus a background live refresh that shows the reference as
*unchanged, changed, resolved* or *gone*.

**Out (the design's M5+ list):** references into Thinker's Journal-hosted code and services, other sources, the marketplace.

## 3. Sources: what each one costs us and what it lets us do

Numbers are from the named pages, read 2026-10-25.

| Source | Auth | Budget (read) | Rules that shape the design |
|---|---|---|---|
| **GitHub** | A GitHub **App** (design decision 6), installation tokens | 5,000 requests/hour per installation, scaling with repositories and users to a **12,500** cap; secondary limits: 100 concurrent requests, 900 points/minute for REST (a `GET` is 1 point). Source: docs.github.com, "Rate limits for the REST API" | A conditional request (`If-None-Match` with the stored `ETag`) that returns `304` **does not count against the primary limit** when it carries a valid `Authorization` header (docs.github.com, "Best practices for using the REST API"). So polling by ETag is nearly free, as the design assumed. Limits "can change without notice". |
| **GitLab** | OAuth (design decision 6) | gitlab.com, today: **2,000 requests/minute per authenticated user**, **500/minute per IP unauthenticated**. GitLab has published *proposed* per-plan limits (free: 5,000/hour sustained, 100/minute burst for API traffic; unauthenticated 60/hour per IP) that are "not yet in effect". Source: docs.gitlab.com, "GitLab.com rate limits" | The proposed limits are far tighter than today's. Plan for the **proposed** numbers: a per-user hourly budget, and refresh by conditional request. Re-read the page when building. |
| **YouTube** | An API key (public metadata only) | Data API default **10,000 units/day**, shared across endpoints; `videos.list` costs **1 unit**. Source: developers.google.com, "Quota cost" | The Developer Policies (developers.google.com/youtube/terms/developer-policies, III.E): stored API data must be **refreshed or deleted every 30 days**; we must display the most updated data; we may not cache or store copies of the audiovisual content; a user's deletion request must be honoured **within 7 days**; YouTube must be attributed as the source; the player must not be modified. **This changes the snapshot rule for YouTube** (section 5, Q2). |
| **X** | The X API, pay-per-use credits (plus the embed route) | Pay-per-use since early 2026. Third-party sources put a post read near $0.005 and report a 2 million reads/month cap; **unverified**: those sources conflict and X's own pricing page must be read before any number is used | The X Developer Policy (docs.x.com/developer-terms/policy): stored X content must be **kept current**, and deleted or modified within **24 hours** of its deletion or modification on X; content no longer available via the API must be removed "as soon as reasonably possible"; unless X's own embed is used, the API must be used to display the most current version; embedded posts need a legally sufficient notice and consent for data collection. The heaviest compliance of the five (section 5, Q3). |
| **Generic web** | none | the target's own politeness; our budget is a fetch rate and byte cap | No third-party terms to honour per site, but we fetch arbitrary URLs from a Worker: SSRF protection (no private or link-local addresses, no non-HTTP schemes, a redirect limit, a response-size and time cap), a descriptive `User-Agent`, `robots.txt` respected for unfurls, conditional `GET` for refresh. We store the title, description and the image's **address**, not its bytes, unless section 5 Q5 rules otherwise. |

## 4. How it is built (the design, made into tasks)

The design fixes these parts; the tasks below only order them.

- **Data.** `references` (one row per resolved resource), `post_references` (a post's use of one, with the token), and
  envelope-encrypted `source_connections`. Private-resource rows are keyed by the owning connection and **never shared across
  authors**; public resources dedupe by content hash. Snapshots are bounded rows plus R2 blobs.
- **Connector interface** per source: `identify / resolve / fetchLive / deepLink`, with `LiveState.access` kept apart from
  `LiveState.diff`.
- **Refresh is access-driven** (decision 22): a view serves the last known state and enqueues a refresh for next time; `next_check_at`
  tapers with `last_viewed_at`; an unviewed reference goes **dormant** and wakes on its next view. A Cron + Queue sweep works only
  the small recently-attended set. Renders read Postgres and KV only, never a source API.
- **Budget.** A per-author rate-budget Durable Object spends each author's connection budget; a stale reference is retried later,
  never in a hot loop.
- **Private references** freeze to their snapshot by default (opt-in to stay live), with a kill-switch to snapshot-only on a
  material change, and the captured private content is purged **30 days after the token is revoked** (decision 17) with "access
  lost" shown.
- **Notifications** for a reference change reuse the M2 notification pipeline.

## 5. Order of work

Each task is its own PR, with the repository's usual review and CI, and a migration says so in its title.

| # | Task | Why here |
|---|---|---|
| M3.0 | Settle Q1-Q5 below with CireSnave; write the connector contract as a spec | the decisions change the schema |
| M3.1 | Schema (migration), connector interface, the `{{ref:TOKEN}}` render in `packages/markdown`, and the **generic web unfurl** with SSRF controls, snapshot capture and a card component | needs no credentials, exercises every layer end to end, and is the safest fetcher to get right first |
| M3.2 | The refresh engine on the generic connector: `live_state`, `next_check_at` taper, the Queue consumer, the per-author budget DO, the diff states | proves the access-driven design before an API with a budget is attached |
| M3.3 | **GitHub App**, public resources only: issue, pull request, file and line range, CI check; ETag polling; webhook-ready | the highest-value source; public-only keeps secrets out of the first cut |
| M3.4 | Authoring: paste-to-enrich and the `@` / slash picker (islands in the editor) | usable once there is a connector to pick from |
| M3.5 | Private resources: `source_connections` envelope encryption, freeze-to-snapshot, the kill-switch, the 30-day purge after revoke | the riskiest data; built after the public path is proven |
| M3.6 | **GitLab** OAuth connector, on the proposed (tighter) budget | same shape as GitHub |
| M3.7 | **YouTube**, under the 30-day rule | after Q2 |
| M3.8 | **X**, if Q3 says yes | last: cost and compliance weight |
| M3.9 | Reference-change notifications on the M2 pipeline | needs real change events |
| M3.10 | Hardening and launch gates: egress alerting on the connector Workers, the privacy-policy and Terms additions for third-party content, moderation and DMCA coverage of reference cards, the patent re-sweep (a new family of capability: `docs/PATENT-SWEEP.md` says to re-sweep when M3 is added), load and budget tests | the closing gate for "launch is held until M3 exists" |

**What "M3 exists" means for the launch hold** is itself Q1: the minimum connector set that lifts the hold.

## 6. Cross-cutting rules every M3 task inherits

- No credential in a repository or a PR; connector secrets are Workers secrets; the GitHub App private key and the OAuth client
  secrets are CireSnave's to register and set, filed on the PM's board per task.
- A third-party term is a requirement: a source whose terms the design cannot meet is not shipped until they can be (Q2, Q3).
- Hidden or removed content: a reference card on a moderated post follows the post; a takedown of the card's subject follows the
  DMCA flow (R9).
- Vendor names stay out of the repository where the PM's rules say so (the hash-matching service); the five sources named here are
  the product's own public integrations.

## 7. Open questions for CireSnave (via the PM)

1. **Q1 — the launch hold's minimum.** Does "M3 exists" mean all five connectors, or generic web + GitHub + the picker (M3.1-M3.4),
   with GitLab, YouTube and X as fast-follows? The design chose a unified launch; the adversarial review recommended the smaller set.
2. **Q2 — YouTube and the snapshot.** The policy forces a 30-day refresh-or-delete, which conflicts with "a snapshot always renders" and
   with dormant references. Options: (a) YouTube references render from live data only, with the title and thumbnail dropped when
   a refresh is overdue; (b) use only the embed with no stored metadata; (c) leave YouTube out of the launch set. Recommended: (b).
3. **Q3 — X.** Pay-per-use cost scales with views of reference cards, and the 24-hour deletion duty needs a compliance sweep. Options:
   (a) the API with the full duty; (b) X's own embed (a script from X on the reader's page: a consent and CSP question); (c) leave X
   out of the launch set. Recommended: (c), revisit with real demand and X's current pricing page.
4. **Q4 — accounts to register.** A GitHub App and a GitLab OAuth application under CireSnave's ownership, and a Google Cloud project for
   the YouTube key. None can be created by a lane.
5. **Q5 — images in unfurls.** Store only the image's address (cheap; the card breaks when the source moves it), or fetch and store a
   resized copy (robust; a copyright and storage question, and it needs the upload scan's decisions). Recommended: address only at first.
