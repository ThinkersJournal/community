# Community Guidelines — DRAFT (not in force; not reviewed by an attorney)

> ⚠️ DRAFT. Not in force. See `README.md`. `[[BRACKETED]]` = to be filled.

**Effective:** [[EFFECTIVE_DATE]] · Operated by [[LEGAL_ENTITY]]

Thinker's Journal is a community for people who build and think in public. These
Guidelines keep it a place where good-faith work and honest discussion are safe.
They apply to everything you post — writing, comments, images, your profile, and
your handle. By using the service you agree to the [Terms of Service](terms-of-service.md),
of which these Guidelines are a part.

## 1. What is not allowed

You may not post, upload, or link to content that:

1. **Is illegal**, or facilitates illegal activity.
2. **Sexually exploits or endangers children** in any way. This is a zero-tolerance
   category. Child sexual abuse material (CSAM) is removed, and we report it to the
   National Center for Missing & Exploited Children (NCMEC) as required by law.
   (See the [Privacy Policy](privacy-policy.md) for how reporting data is handled.)
   [[NOT YET TRUE AS WRITTEN — status 2026-10-01, issue #114. What exists today:
   a human moderator removes matched media by placing a legal hold. What does
   NOT exist yet: any automated match → remove pipeline; any way to terminate an
   account (nothing sets `disabled_at`/`suspended_until`; see #113); and any NCMEC
   CyberTipline reporting, automated or manual. Whether Cloudflare's CSAM Scanning
   Tool is enabled on the production zone cannot be verified from this repository.
   CireSnave's ruling (verbatim, relayed by the PM): "the automated CSAM/NCMEC
   reporting needs to be built sooner rather than later and it must exist before
   we open the community project up to users officially." Do not restore wording about
   scanning, termination, or automatic reporting until #114 ships it.]]
3. **Threatens, harasses, bullies, or incites violence** against a person or group.
4. **Is hate speech** — attacks or dehumanizes people based on race, ethnicity,
   national origin, religion, disability, sex, gender identity, sexual orientation,
   or serious disease.
5. **Is non-consensual intimate imagery**, or sexualizes a real, identifiable
   person without consent.
6. **Doxxes** — publishes private information (home address, phone, government ID,
   financial details) about someone without their consent.
7. **Is spam** — bulk, repetitive, deceptive, or purely promotional posting; SEO
   manipulation; engagement farming.
8. **Distributes malware, phishing, or scams**, or attempts to compromise the
   service or other users' accounts.
9. **Impersonates** a person or organization, or misrepresents your affiliation.
10. **Infringes intellectual property** — posting others' work as your own, or
    without the right to do so. Copyright complaints follow the
    [DMCA Policy](dmca-policy.md).

**Handles** are yours and public while your account is active. If you delete your
account, your handle may become available to someone else after a 30-day grace
period. You may not squat, sell, or use a handle to impersonate; reserved and
misleading handles may be reclaimed.

## 2. How moderation works

We aim to be transparent about enforcement. It is **human-reviewed**; automated
signals only *prioritize* review, they do not decide it.

- **Reporting.** Any signed-in member can report a post or comment. Reports feed a
  ranked review queue. Reporting in bad faith (mass or retaliatory reporting) is
  itself a violation.
- **Provisional auto-hide.** When a single piece of content is reported by
  **[[3]] or more distinct members within 24 hours**, it is **hidden pending
  review** — not deleted. This limits the reach of likely-bad content without a
  human having yet judged it; a reviewer then confirms or restores it. *(Design
  decision #14.)*
- **Pre-publish scoring.** New posts and comments may be machine-scored for likely
  policy violations. A score **routes content into the review queue — it never
  hard-blocks a publish** on its own.
- **Actions ladder.** For confirmed violations, enforcement generally escalates:
  **warning → temporary suspension → permanent ban**, proportionate to severity
  and history. Severe violations (e.g. CSAM, credible threats) skip the ladder and
  result in immediate termination. [[STATUS — warning, suspension and ban exist (#113 plan A). "Immediate
  termination" for CSAM exists as a primitive but is not yet wired to detection
  or NCMEC reporting (#114). Appeals exist (#113 plan B).]]
- **Appeals.** If your content or account is actioned, you may appeal through
  the appeal link in the notice we send you (or, for a hidden post, in the
  post's editor), within 30 days of the decision (except a termination, which
  can't be appealed). A different reviewer, where practical, reviews the appeal.
- **Audit.** Moderation actions are recorded in an append-only internal log for
  accountability and to support appeals.
- **Reporting illegal content without an account.** We accept reports of legal
  violations (such as child sexual abuse material, copyright infringement, or
  harassment) without requiring a login through a public form at `/dsa-notice`. The reporter provides their name,
  email, the reason category, and a statement. They confirm their email address via
  a link we send them — until they do, the report is inert. Once confirmed, the
  notice goes to a moderator's review list. **Notices are reviewed by a person; they never
  hide content automatically.** After review, we email the reporter the outcome and
  the moderator's reason for the decision.

## 3. Blocking another user

You can **block** another member. A block is about **interaction, not
invisibility**, and we describe it honestly:

- The person you block **cannot follow you, comment on your posts, or react to
  your content**; their posts no longer appear in your feed, and notifications
  between you are suppressed.
- **It does not make your public posts private.** Your posts stay public, so a
  blocked person may still read them — for example while signed out — the same as
  anyone else. Blocking is not a way to hide public writing from a specific person.

Blocking already removes that person from your feed. If we offer **muting**, it
goes further — hiding them everywhere else they would otherwise appear, such as
comment threads on other people's posts, search, and mentions — without limiting
what they can do. If someone's behavior violates these Guidelines, **report** it:
blocking manages your own experience, reporting is how content gets reviewed.

## 4. Your responsibilities

- Post your own work, or work you have the right to share, and attribute honestly.
- Report content you believe violates these Guidelines rather than escalating it
  yourself.
- Keep your account secure; you are responsible for activity under it.

## 5. Changes

We may update these Guidelines as the community grows or the law changes. Material
changes will be announced. Continued use after a change means you accept it.

*Questions or reports that can't go through the in-app tools: [[CONTACT_EMAIL]].*
