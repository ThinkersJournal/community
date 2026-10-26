# Machine scoring of new posts and comments: design (S26 c)

**Status:** DESIGN, one page, 2026-10-25. Nothing is built. CireSnave's ruling (board 287, S26 c, via the PM): build both the 7-day tag
gate (done, #261) and "spam/policy scoring", design first: **vendor, privacy-policy change, review-queue routing**. The
`[[MODERATION_SCORER]]` placeholder in `docs/legal/privacy-policy.md` stays until a vendor is chosen.

## 1. What it is, and what it is not

New posts and comments are scored when they are published. A score **routes the item into the moderation queue, ranked**; it never
hides, removes or restricts anything, and no notice goes to the author. That keeps two rules the design already has: only a human
writes a `content_*` ruling (`decide.ts`), and the platform "scores into a queue, not hard-block" (design, Moderation & safety; so a
legitimate security-research post is not censored by a classifier). Auto-hide stays what it is: three distinct member reports.
Scoring is advisory and **fails open**: if the scorer is down the post publishes and simply has no score.

Out of scope: images (the upload scan owns them) and anything touching child-safety material (never sent to a scorer).

## 2. Vendor options (read 2026-10-25)

| Option | Facts | Fit |
|---|---|---|
| **Cloudflare Workers AI, Llama Guard 3 8B** (`@cf/meta/llama-guard-3-8b`) | On the platform we already use. $0.484 per million input tokens, $0.03 per million output tokens; 131,072-token context (developers.cloudflare.com, model page). It reports unsafe content and the categories violated; the page does not list the categories | **Recommended.** No new vendor or sub-processor, so the privacy change is small (section 4); cost is small at launch volumes (a million 500-token posts would be about $240 of input). Output is a verdict plus categories, not a calibrated score, which is enough to route into a queue |
| **OpenAI `omni-moderation-latest`** | "The moderation endpoint is free to use"; text and image input; per-category scores (harassment, hate, illicit, violence and others); do not send known or suspected CSAM; OpenAI plans to keep upgrading the model, so thresholds need recalibration (developers.openai.com, Moderation guide) | A good second scorer if calibrated scores are wanted. A third party receives user text, so it is a disclosed sub-processor (the architecture research already says so) |
| **Perspective API** | Its own site says it stops accepting new requests after February 2026 and ends service on **2026-12-31** (perspectiveapi.com) | **Ruled out** |
| **Heuristics only** | link density, a first-time domain, account age under 7 days, post bursts. Deterministic, no vendor, no data leaves | Do first regardless: cheap, explainable, and needed even with a model |

## 3. Routing into the review queue

- A new table `content_scores` (migration, NEW MIGRATION in the PR title): the post or comment id, the scorer and its version, `flagged`,
  the categories, `created_at`. No post text, no reporter. Retained 90 days (a proposal for the attorney, as for the other logs).
- The queue (`queue.ts`) gains a third reason to list an item, beside reports and DSA notices: `scored`, ranked after items with human
  reports and by category severity, and **below nothing a person has handled** (a human `content_*` ruling newer than the score closes it, as it
  does for reports).
- A scored item shows the moderator the categories and "machine-flagged", never a number that looks like a verdict. The queue's
  `reports`-count and auto-hide logic do not read `content_scores` (the AC-1 rule the DSA notices have: nothing automatic may start
  to act on it).
- The author is told nothing unless a human rules. A human ruling's notice does not mention the score (the statement of reasons is the
  moderator's, DSA Art. 17).

## 4. Privacy-policy change

With Workers AI: fill the `[[MODERATION_SCORER]]` row with *content is scored on Cloudflare's infrastructure, which already processes our
requests; it is not sent to a separate vendor and is not used to train models* (the second clause is **unverified** and must be checked
against Cloudflare's Workers AI terms before it is published). With OpenAI added later: a new sub-processor row and an updated purpose
line. The Community Guidelines already say posts "may be machine-scored"; the audit (guidelines-intentions, row 5) flagged that as
unbuilt, which this resolves.

## 5. Build order

1. Heuristics scorer + `content_scores` + the queue reason, behind a flag (default off). NEW MIGRATION.
2. The Workers AI call (async, `waitUntil`, bounded text, a timeout, fail open, a failure counter without content in the log).
3. The privacy-policy text and the Guidelines wording check; turn the flag on after CireSnave reads the filled row.

## 6. Questions for CireSnave (via the PM)

1. **Vendor:** Workers AI first (recommended), or OpenAI's free endpoint, or heuristics only for launch?
2. **Queue priority:** may a machine-flagged item with no human report sit in the queue at all (the queue today holds only reported or
   noticed items)? Recommended: yes, ranked last.
3. **Retention** of `content_scores`: 90 days proposed.
