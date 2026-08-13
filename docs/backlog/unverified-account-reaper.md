# Unverified-Account Handle Reaper — Requirements

> **Status:** Backlog. Companion to the handle-at-signup decision
> (`docs/pre-launch-fixes.md` #1, decided 2026-08-13). Pre-launch-vs-deferred is
> a founder sub-decision.

## Why

Handle selection moved onto the signup form — the `@handle` is chosen **before**
email verification. That reintroduces **handle squatting**: an unverified or bot
account can reserve a desirable handle it never uses, permanently occupying the
namespace. This reaper releases handles held by accounts that never verify.

## Requirement

Periodically reclaim handles from never-verified accounts:
- **Target:** `users` where `email_verified_at IS NULL` **and** `created_at`
  older than a grace period (proposed **7 days** — long enough for a real user
  to get around to verifying, short enough to limit squatting).
- **Action** (decide at spec time):
  - **Delete the account row** — `profiles` cascades via
    `ON DELETE CASCADE`, freeing both the handle and the email. Simplest.
  - **or Soft-release** — null/rename the username and mark the account
    reclaimable, keeping the email record. More conservative.
- **Runner:** a cron. The app already runs crons (`*/2 * * * *` email-drain,
  `0 14 * * *` daily digest); a daily pass is ample.

## Safety / interactions

- **Never reap mid-verification:** key off `created_at` age, not last activity,
  and keep the grace period comfortably longer than the verification email's
  useful life.
- **Turnstile** is on signup, throttling bulk automated signups — this reduces
  (not eliminates) squatting pressure, and is why **deferring the reaper is
  defensible at low launch volume**.
- Scope is only never-verified accounts; deletion of verified accounts for other
  reasons is a separate concern.

## Disposition

Ship-before-launch vs. defer is a founder sub-decision (see
`docs/pre-launch-fixes.md` #1). Requirement captured now so it isn't lost
regardless of timing.
