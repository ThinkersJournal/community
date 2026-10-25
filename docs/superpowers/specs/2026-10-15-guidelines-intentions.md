# Community Guidelines: stated intentions that are NOT built (internal)

**Status:** internal record. Part of #57. **Not linked from any public page.**
**Ref:** the pre-publication draft of `docs/legal/community-guidelines.md` (git history before the
commit that published it) against `feat/guidelines-publishable`, stacked on `feat/art17-copy-store`
c587053. File cites are at that base; re-verify before acting on any of them.

The published Guidelines state only what the platform does today. The draft also said the
things below. Each was **removed from the public text** because code does not do it. Putting any
of them back is a product decision AND a code change; the public text must change in the same PR
as the code, and `GUIDELINES_VERSION` (`packages/shared/src/guidelines.ts`) must change with it.

| # | Draft promised | Code today | Where it would land |
|---|---|---|---|
| 1 | Severe violations (CSAM, credible threats) "skip the ladder and result in immediate termination". | `user_terminate` exists as a primitive (`apps/api/src/moderation/account-actions.ts`, `AccountActionKind`), but `ADMIN_ACCOUNT_ACTIONS` is warn/suspend/ban only (`packages/shared/src/admin.ts`, "terminate is deliberately NOT here") and no non-test caller passes `kind: "terminate"`. Ban is the maximum a moderator can apply, and is reversible on appeal (`moderation/appeals.ts`, `user_ban` case). `APPEALABLE_ACTIONS` excludes `user_terminate`, so "termination is not appealable" is a rule about a path nobody can reach. | #114 (CSAM path) / #113. [Update 2026-10-25: a moderator route now calls it, `POST /admin/accounts/:handle/terminate` (#212); the public Guidelines still do not promise termination.] Needs a detection-to-terminate caller, a legal ruling on whether a terminated user may be told why (`notify-account.ts` header), and public appeal rules for termination. |
| 2 | CSAM is "removed, and we report it to NCMEC as required by law." | No CyberTipline reporting, automated or manual. The only app-source hit for NCMEC is a comment (`apps/api/src/media/legal-hold.ts`). A moderator can remove content and place a legal hold, nothing more. Whether Cloudflare's CSAM Scanning Tool is enabled on the production zone cannot be read from the repo. CireSnave's ruling (relayed by the PM): reporting "needs to be built sooner rather than later and it must exist before we open the community project up to users officially." | #114. Needs ESP enrolment, the CyberTipline API client, preservation handling, and the two open legal questions that gate the trigger. The public statement returns only when it is true on the production zone. |
| 3 | "Reporting in bad faith (mass or retaliatory reporting) is itself a violation." | No category for it (`REPORT_REASONS`, `packages/shared/src/moderation.ts`), no sanction path, no moderator-visible per-reporter pattern. | A per-reporter report history in `queue.ts`, a contractual ground for it (`CONTRACTUAL_GROUNDS`, `admin.ts`; the ground-enums spec lists none), then the clause. |
| 4 | Handles: reserved and misleading handles "may be reclaimed"; squatting and selling forbidden. | A reserved list blocks signup (`auth/reserved-usernames.ts`); no reclaim mechanism, no rename-by-moderator path. The true part: a deleted account's handle is freed at anonymisation, 30 days after the deletion request (`auth/anonymise-accounts.ts`); that sentence was dropped with the paragraph and can return alone. | A moderator action "reassign handle" with an audit row and a notice; or keep it out. Impersonation (item 9) already covers the abuse through ban. |
| 5 | "New posts and comments may be machine-scored for likely policy violations ... routes content into the review queue." | No scoring code. The privacy draft also names a `[[MODERATION_SCORER]]` vendor that does not exist. | A scoring step on the publish path writing a queue signal, never `hidden_at`; the privacy policy's processor table changes in the same PR. |
| 6 | "Automated signals only *prioritize* review, they do not decide it." | False as written: `maybeAutoHide` (`moderation/auto-hide.ts`) sets `hidden_at` with no human. The published text says so plainly (section 3, "Automatic hide"). | Nothing to build; a wording correction recorded so it is not re-introduced. |
| 7 | Account actions "generally escalate: warning, temporary suspension, permanent ban", "proportionate to severity and history". | No ladder enforcement. A moderator may apply any of the three first; history (12 months, `ESCALATION_WINDOW_MONTHS`) is shown to the moderator, not applied. The published text says moderators are not required to start with a warning. | Only if policy requires it: a server-side rule in `applyAccountAction`. |
| 8 | "A different reviewer, where practical, reviews the appeal." | Not enforced. `resolveAppeal` computes `sameReviewer` and reports it, never refuses (`moderation/appeals.ts`, "Reported, never refused"). With one moderator it cannot be true. | Refuse a same-hand decision when a second moderator exists, or keep it unstated. |
| 9 | "Material changes will be announced. Continued use after a change means you accept it." | No announcement mechanism and acceptance is not recorded. Notice emails now carry the version in force (`notify-author.ts` `guidelinesLine`), the only change-visibility the platform has. | An in-app or email notice on a version bump, an acceptance record, and the Terms. |
| 10 | "By using the service you agree to the Terms of Service, of which these Guidelines are a part"; links to the Terms, Privacy and DMCA documents. | Those three are still unpublished drafts (`docs/legal/README.md`), so the public page links to none of them. The Footer's Privacy link goes to the marketing site (`thinkersjournal.com/privacy`), which this repo cannot verify. | Publish each document, then add the links and the incorporation sentence. |
| 11 | "Operated by `[[LEGAL_ENTITY]]`" and a contact email. | The legal entity is undecided, and the repo publishes no general contact address on any page (the DMCA agent address serves DMCA notices only and must not become a general contact; see `docs/legal/README.md`). Both lines were omitted rather than published as placeholders. | After CireSnave decides the entity and a contact address. [Update 2026-10-25: the published Guidelines now end with a Contact section naming contact@thinkersjournal.com; the legal-entity line is still omitted.] |
| 12 | "If we offer **muting**, it goes further ..." | No mute feature exists. | A mute table and read-path filters; out of scope. |
| 13 | "Reports feed a ranked review queue." | A queue exists (`moderation/queue.ts`); "ranked" was not checked in this pass and was not carried over. | Verify `queue.ts` ordering, then restore if wanted. |

## Notes for the next editor

- The ten numbered items in section 1 keep their numbers on purpose: `CONTRACTUAL_GROUNDS` in
  `packages/shared/src/admin.ts` maps to items 3-10 by number (`2026-10-14-art17-ground-enums.md`),
  and `apps/web/test/guidelines-markdown.test.ts` fails if items 1-10 move.
- Item 2 (children) now says content is removed and the account banned. That is a moderator's choice
  of `remove` and `ban`, both of which exist; it promises no reporting and no automation.
- Stored moderation-notice records (#57 Q9, `moderation/notice-records.ts`) now hold text that
  includes the Guidelines version and URL, so a record shows which version the author was pointed at.
- `guidelines` is now a reserved handle (`auth/reserved-usernames.ts`) because `/guidelines` is a
  static page that would shadow a profile of that name.
