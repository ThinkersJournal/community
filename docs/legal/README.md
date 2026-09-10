# Legal policy DRAFTS — for attorney review

> ⚠️ **THESE ARE DRAFTS, NOT LEGAL ADVICE, AND NOT IN FORCE.** They were prepared
> by the Community controller agent as a **starting point for a qualified attorney
> to review, correct, and finalize** (design decision #21 requires an attorney pass
> on ToS / Guidelines / Privacy / DMCA before launch). Nothing here should be
> published, linked, or relied upon until a licensed attorney has reviewed it and
> CireSnave has approved the final text.

## What's here

| File | Purpose |
|---|---|
| `terms-of-service.md` | The master user agreement. |
| `community-guidelines.md` | The behavioral rules + how moderation works (encodes design decision #14). |
| `privacy-policy.md` | What data is collected, why, who processes it, retention, user rights. |
| `dmca-policy.md` | §512 takedown / counter-notice process + repeat-infringer policy. |

## Placeholders the attorney / founder must fill

Every `[[BRACKETED]]` token is a deliberate blank that needs a real value and/or a
legal decision:

- `[[LEGAL_ENTITY]]` — the operating entity's legal name. **Unsettled** — the
  design flags a 501(c)(3) + taxable-subsidiary structure that a nonprofit
  attorney must bless first. The policies cannot be finalized before this is.
- `[[JURISDICTION]]` — governing law / venue (US state).
- `[[CONTACT_ADDRESS]]`, `[[CONTACT_EMAIL]]` — service + general contact.
- ✅ `[[DMCA_AGENT_*]]` — **FILLED, and corrected 2026-09-08 against the actual
  registration record.** The U.S. Copyright Office registration is **active**:
  **DMCA-1079944**, service provider *Thinker's Journal*, designated agent Eric Evans.
  `dmca-policy.md` now mirrors that record exactly — name, organization, address,
  phone, and email.
  - ⚠️ **The published email was wrong until this correction.** The policy carried
    `ciresnave@gmail.com`; the registration is `ciresnave@yahoo.com`. **A policy that
    publishes a different address than the one on file defeats the purpose of a
    designated agent** — a notice sent to the published address would not reach the
    registered one — so these two must never be allowed to drift apart again. If the
    contact ever changes, the Copyright Office record and this file change *together*.
  - The **registration number is recorded here for renewal tracking only** (the
    registration must be renewed every three years) and is deliberately **not published
    in the policy** — §512(c)(3) does not require it in the notice-and-takedown text.
  - ⚠️ **The phone number is published for DMCA notice-and-takedown ONLY.** CireSnave
    authorised it with the constraint attached, and **the constraint travels with the
    permission**: *"Obviously, don't put it in as a primary contact number for the site
    but for things like DMCA where there are legal reasons for people to \*need\* to
    contact me, I'm fine with it."* It is a personal line. It must not appear in a
    footer, a contact page, an `/about`, or structured data. If the site needs a contact
    number, that is a **different number and a different decision** — not this one
    reused. Enforced by `apps/api/test/dmca-phone-only-on-dmca-page.node.test.ts`, which
    reads the number *from this policy* and fails if any other file in the repository
    carries it.
  - ⚠️ **A registration is only as good as the inbox behind it.** The address published
    here must be one the agent actually reads. If `ciresnave@yahoo.com` ever stops being
    monitored, that is **a re-filing with the Copyright Office**, not an edit to this
    file — the two must never diverge (see above).
  - ⚠️ **This does NOT settle `[[LEGAL_ENTITY]]`.** "Thinker's Journal" is the *service
    provider name on the DMCA registration*, which is not the same thing as the
    operating entity's legal name; that still waits on the 501(c)(3) question below.
- `[[EFFECTIVE_DATE]]` — set at finalization.

## Grounding

The substantive content is grounded in the platform's **actual** behavior and the
approved design (`docs/superpowers/specs/2026-07-13-community-platform-design.md`,
decisions #14 moderation, #17 private-ref retention, #18 media, #21 legal). Where a
draft asserts a data practice or an enforcement rule, it reflects what the code
does or what the design commits to — not a generic template. The attorney should
still verify each against the final implementation.
