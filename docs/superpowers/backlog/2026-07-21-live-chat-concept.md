# Thinker's Journal — Community "Live Chat" Feature Concept

**For:** the Community platform (project ②) — to log as a **future / post-launch** feature plan.
**Origin:** design conversation between Eric and the ThinkersJournal.com website agent, 2026-07-21.
**Status:** Concept only. NOT scheduled and NOT competing with current M2 work. Parked as a **post-M4 (post-launch) retention/engagement feature**, to be brainstormed properly on the Community side once the moat (M0–M4) has shipped.

---

## 1. Strategic framing (why this is on-mission, not a hangout toy)

Chat on TJ is deliberately **not** a generic messenger. Because conversations **persist** and can be **quoted/published into community posts**, chat becomes the **synchronous front-end of the building pipeline**:

> conversation → quotable excerpt → published post → reference graph

That welds it to the platform's core moat (the live @-reference system) and to the mission ("no thinker should have to build alone"). A generic chat is a commodity; chat whose output graduates into referenceable, buildable artifacts is something only TJ can offer, because only TJ has the reference graph downstream. This framing is the reason to build it — and it answers the concern that live chat might pull builders *out* of building: here, the chat *feeds* the building.

## 2. The unified model

There are **no pre-provisioned rooms or channels.** There is one object: a **persistent conversation** with a floating set of participants. That single object is simultaneously:

- a **1:1 DM** (2 participants),
- a **group chat** (>2), and
- a **dormant/archived thread** (just the owner).

Because it persists, **this IS the platform's DM system** — no separate DM feature is needed. 1:1 and many-to-many are the same primitive with a changing member count. (Broadcast — one speaker, many passive listeners — is a *different* interaction and belongs with the feed/notifications, not here.)

### Lifecycle

- **Creation.** User B is working and posts about it. User A right-clicks B's name in the post → "Chat" → sends B a chat *request*. On B's acceptance, the conversation exists.
- **Ownership.** The conversation is **owned by the person who was requested** (B) — the recipient of the initiating request, not the initiator. Rationale: A asked to chat with B, so it is B's chat.
- **Adding participants — two-stage consent:**
  1. Someone proposes an add (drags a user toward the chat).
  2. The **owner** receives a request to approve the add.
  3. Only after the owner approves does the **invited user** receive their own request to join.
  Every join request **discloses the conversation's settings** (see §4) so the invitee consents on informed terms.
- **Leaving & dormancy.** As people leave, the conversation shrinks. When only the owner remains, it becomes **dormant — it does not dissolve.** The owner keeps full access and history and can later drag users back in; on joining (with consent per settings), they may see history.
- **Reconnect grace.** Transient disconnects must not collapse a conversation — apply a short grace window before treating someone as "left" (prevents flaky-network churn).

### Merging conversations

- Dragging conversation A toward conversation B proposes a combine. **The old conversation (A) stays separate — it is not destroyed.** Combining brings people together into the target conversation; the source persists independently (dormant if emptied).
- **Content copying is governed by the publish-consent rule (§4):** content may be copied from one conversation into another **only if** the source conversation's settings permitted publishing, **or** every user who authored that content agrees to the copy. (Moving content to a different audience is treated as a form of publishing.)
- **Default posture: forward-only.** Combining co-locates people going forward; it does not retroactively expose either side's prior history unless the copy-consent rule above is satisfied.

## 3. Chat settings & the consent model

Each conversation carries explicit, **disclosed** settings defining its privacy posture. Candidates:

- **Can be published** — may content be quoted/posted into public community posts?
- **Joining users see history** — may a newly added user read messages sent before they joined?
- (Extensible — e.g., who may propose adds; attribution granularity for published excerpts.)

**Consent is via disclosed settings.** Every join/merge request must show the conversation's current settings so each user decides whether to participate. How each user then enforces or waives their own privacy is **their informed choice.**

**Publish / copy consent (decided rule).** Publishing or copying a shared excerpt exposes *other people's* words, so it is permitted only when **the conversation's "can be published" setting allows it, OR every author of the quoted/copied content consents.** (Same test as content-copy in §2.) *Open sub-decision:* attribution of published excerpts — named vs. anonymized, and whether that is itself a per-chat setting.

## 4. Permission-change policy — OPEN DECISION (3 candidates)

How a conversation's settings may change after creation:

1. **Immutable** — no permission changes after creation. Simplest; strongest guarantee (what you joined is what it stays).
2. **Owner-initiated + unanimous consent** — the owner may change settings, but only if **all affected users, including prior participants** whose content is affected, consent.
3. **Always re-request** — any change that could affect a user who has been in the chat requires that user's permission.

Options 2 and 3 both preserve per-user consent and differ mainly in initiator/scope; option 1 sidesteps change entirely. **Decision pending** (pick one, or make it a per-chat policy). **Load-bearing invariant regardless of choice:** a settings change must **never** retroactively expose content a user wrote under more-private settings without that user's consent.

## 5. Privacy realism (explicit platform principle)

TJ will do its best to protect user privacy, **but anything a user does that appears on another user's screen is beyond the platform's control** (screenshots, photos, memory). Therefore:

- Settings like "can be published: off" govern **TJ's own publish/quote tooling**. They are a **policy** guarantee — violating them is a reportable offense — backed by a technical guardrail, **not** a technical impossibility.
- **Users must be told this plainly, up front**, so they calibrate what they share. Never imply a technical un-leakability the platform cannot deliver.

## 6. Prerequisite platform primitives (build BEFORE chat)

Two capabilities underpin chat but are really **Community-core primitives** many features need. Design/build them independently; they land first:

1. **Block / interaction-limiting** — control how (or whether) other users can view and interact with you. Needed by comments, follows, posts, and profiles — not just chat. (Block + report is already in the M0–M4 plan; extend it into a general interaction-permission model.)
2. **Presence / availability with visibility controls** — track online/availability status, with per-user control over **who can see it** (e.g., everyone / follows / mutuals / invisible) and **who may initiate contact.** This is the **engine** of the chat model (you chat with people you can see are online) *and* its main **abuse surface** on open public signup, so the controls are mandatory, not optional. This presence-with-privacy service is the genuinely new primitive and the real engineering core beneath chat.

## 7. Trust & safety notes

- Live, real-time, many-to-many conversation is the platform's hardest moderation surface: needs real-time reporting, eject/block, and — because conversations persist but can go dormant or be left — a **minimal server-side retention path for abuse reports** even when a conversation is no longer visible to a reporter.
- The two-stage add-consent flow and per-author publish/copy consent are the primary structural safety mechanisms. They trade some speed for safety — a fit for TJ's deliberate-builder ethos.

## 8. Open decisions (resolve in the Community-side brainstorm)

1. **Permission-change policy** — options 1/2/3 in §4 (or per-chat configurable).
2. **Attribution of published excerpts** — named vs. anonymized; per-chat setting?
3. **Retention & deletion / right-to-be-forgotten** — what happens to a user's messages in others' dormant chats, and in already-published quotes, when they leave or delete their account. **Decide jointly with the platform's pending EU/UK data-rights policy**, not after.
4. **Ownership succession** — what happens to a conversation if the owner deletes their account (transfer? archive? dissolve?).

## 9. Suggested sequencing

Post-launch (after M0–M4), in order:

1. **Primitives:** block/interaction-limits + presence-with-privacy.
2. **Persistent 1:1 conversations** (= the DM system).
3. **Group via add/merge** + settings & consent flow.
4. **Publish/quote-into-posts** integration with the reference system (the on-mission payoff in §1).

Each stage is independently useful, and once the two primitives exist, chat is largely *composition* over them.

---

*Captured for the backlog. When it's time to build (post-M4), this deserves a proper `superpowers:brainstorming` pass on the project-② side; the above is a head start, not a spec.*
