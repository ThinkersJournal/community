# DMCA takedown, counter-notice and repeat-infringer flow — design note (R9 / S2)

**Status:** DRAFT for PM review, 2026-10-25, at `origin/main` fc58010 (0.1.96). Nothing here is built. Every number is a **placeholder for the attorney** (the policy text is itself an unreviewed draft, `docs/legal/dmca-policy.md`). CireSnave ruled "build it" on 2026-10-25 (board 287, S2). Not legal advice.

## 1. Today (read at fc58010)

- `docs/legal/dmca-policy.md` promises: remove or disable on a valid notice, notify the user with a copy, accept a counter-notice, restore in 10-14 business days unless the claimant sues, and a repeat-infringer policy.
- Code: only a DSA notice intake (`dsa_notices`, `routes/dsa-notice.ts`) with reason `ip_infringement`. It lacks the §512(c)(3) elements (signature, work identified, perjury statement, postal address and phone), has no counter-notice, no restore timer, no strike record. Nothing may read `dsa_notices` for auto-hide (AC-1, migration 0020).
- Reusable: `moderation_actions` (append-only, one writer `actions.ts`), the notice outbox (`moderation_notice_outbox`, one row per `(action_id, kind)`), `content_remove`/`content_restore` and the hidden-reason read, `account-holds` (legal hold), the `/admin` queue pages, the appeals token pattern.
- Policy conflict to settle: policy §4 says there is **no automatic strike counter**, each step a human decision "informed by that record". The R9 row says "strike count". This note builds a **recorded count shown to the moderator**, never an automatic termination, which satisfies both; CireSnave/attorney to confirm.

## 2. Design

**Intake** — new public page `/dmca` form (R1 already plans the route) posting to `POST /public/dmca-notices`, Turnstile-gated like `dsa-notice`. Fields = the six §512(c)(3) elements: typed signature, work description, target URL (resolved to a post/comment as `dsa-notice` does), complainant name/address/phone/email, good-faith statement, perjury statement (both checkboxes, text stored verbatim). Email-confirm the complainant as DSA does; an unconfirmed notice is inert. A notice missing an element is recorded `incomplete` and the complainant told which element; it does not trigger takedown (§512(c)(3)(B)).

**Storage** — new table `dmca_notices` (migration; CireSnave applies before merge): the fields above, `target_kind`, nullable `post_id`/`comment_id` `ON DELETE SET NULL` plus a `target_label` snapshot (same reasoning as 0020), `state` (`pending_review | taken_down | counter_received | restored | rejected | withdrawn`), `taken_down_at`, `counter_received_at`, `restore_after`, `claimant_sued_at`, and `retain_until`. A second table `dmca_counter_notices` (the §512(g)(3) elements, text verbatim, one per notice). Complainant PII has a retention window (placeholder 3 years after closure; attorney).

**Takedown** — a moderator reviews the confirmed, complete notice in a new `/admin/dmca` queue (a second panel in the existing queue, not a second system). Accept = one transaction: new `moderation_actions` kinds `dmca_takedown`, plus the hide (`hidden_at`) and an author notice enqueued in the outbox (new kind `dmca_notice_to_author`, carrying a copy of the notice per policy §2 and the counter-notice route). Reject = `dmca_reject`, complainant told. These are new kinds, so a CHECK-swap migration like 0029/0030; ground recorded as legal ground `copyright` (extend the `LegalGround` enum, `packages/shared`).

**Counter-notice** — token link in the author notice (appeals token pattern) to `/dmca/counter`: the four §512(g)(3) elements, jurisdiction consent. On valid receipt: state `counter_received`, `restore_after = received + 10 business days` (placeholder; policy says 10-14), complainant forwarded a copy via the outbox (`dmca_counter_to_claimant`) and told they must file suit to stop restoration.

**Restore timer** — a daily cron (same shape as the notice purge) restores items with `restore_after <= now()` and no `claimant_sued_at`, writing `dmca_restore` and notifying both parties. A moderator records `claimant_sued_at` on the notice (a button; the claimant's lawsuit notice arrives by email to the agent, never through the form) which cancels the timer. Never restore automatically if an account legal hold exists on the author.

**Repeat infringer** — each accepted takedown not later reversed in the author's favour (`dmca_restore` after a counter-notice or a withdrawal) counts as one strike for the author. The account page shows the count and the notices; reaching the placeholder threshold (3 in 12 months) raises a flag in the admin queue only. Termination stays a manual `user_terminate`, preserving policy §4 as written.

**Not in this note** — DMCA agent registration renewal (S24, needs CireSnave's date); text of any notice (attorney); counter-claims outside the U.S.

## 3. Build order (each a separate PR, each with red-first tests)

1. Migration + `dmca_notices` intake route and `/dmca` form + the policy page link (R1 overlap: the `/dmca` route may be built here if the PM wants it earlier than the other legal pages).
2. Admin queue, accept/reject, takedown action and author notice.
3. Counter-notice route, forwarding, restore timer, claimant-sued button.
4. Strike count display and flag; attorney-parameter constants in `packages/shared`.

## 4. Questions for CireSnave (via the PM)

1. Strike threshold and window (3 in 12 months is a placeholder), and confirm "count and flag, manual termination" satisfies his "strike count".
2. Is the 10 or the 14 business-day figure the one to use?
3. May the `/dmca` form carry the Designated Agent's postal address and phone (the existing test `dmca-phone-only-on-dmca-page` pins the phone to the `/dmca` page only)?
4. Retention window for complainant PII.
