# M3.9 design note: reference-change notifications (DRAFT for pm-web, no code, no migration)

**Status:** proposal, 2026-11-19, lane: community. Facts read at `origin/main` 590619aa. Plan row: `docs/superpowers/plans/2026-10-25-m3-reference-engine-plan.md` M3.9 ("needs real change events").

## 1. The event
`refreshReference` (`apps/api/src/references/refresh.ts`) is the only writer of `"references".live_state`. It returns `"refreshed"` after a **definitive** look; `diff: "unknown"` (rate limit, error, forbidden) returns earlier and never touches `live_state`. The event is: **a definitive look whose `diff` differs from the stored one**, with a stored `live_state` already present. `Diff` = `unchanged | changed | resolved | gone | unknown` (`packages/shared/src/references.ts:54`). `unknown` never notifies. The very first look (stored `live_state` null) never notifies: there is no baseline, and the first sweep over existing references would otherwise storm every author.

## 2. Who is told (RULING 1)
**The authors of published, non-removed posts that use the reference** (`post_references` join `posts`), and nobody else. They are the only people who can fix a stale card. Not readers or followers (that is a "watch" feature, with its own privacy and noise cost). Not drafts (the author sees the card on open). Not moderated or deleted posts. One notification per (author, post), not per use.

## 3. Which states (RULING 2)
- `gone`: **notify.** The card turns into "no longer available"; the author may want to edit.
- `changed`: **notify, once per distinct new content** (dedupe on the new `content_hash`, section 5).
- `resolved`: **do not notify** (informational; the card already shows the label).
- `unchanged`, `unknown`: never.

## 4. Shape (RULING 3: schema approach)
`notifications` (`0005`) requires `actor_id NOT NULL`, has `CHECK (recipient_id <> actor_id)`, and a kind CHECK of five values; a refresh has no actor. Two options:
- **A (recommended): extend the table.** One new migration: add kind `reference_changed`; `actor_id` DROP NOT NULL (the no-self CHECK already passes on NULL); add `reference_id uuid REFERENCES "references"(id) ON DELETE CASCADE` and `reference_event text` (`gone` or `changed:<content_hash>`); replace the unique key with one that includes them. Additive and fast, but it alters the hot table and the unique constraint needs a drop-and-add.
- **B: a separate `reference_notifications` table**, merged at read time. No change to the hot table, but the bell, badge, seen watermark and email drain all need a second source.
The write goes through the one seam (`notifications/create.ts`), after the update commits, never throwing. The block check is skipped (system event, no actor). The bell text is a fixed label plus the post title; **no snapshot text is ever put in a notification** (it is third-party content).

## 5. Dedupe
`UNIQUE NULLS NOT DISTINCT (recipient, actor, kind, post, comment, reaction_kind)` makes a notification once-ever. For references the key gains `(reference_id, reference_event)`: `gone` once ever, `changed` once per distinct content hash, so a flapping resource cannot re-notify and a real new change can.

## 6. Channel (RULING 4)
Reuse `notification_prefs` (`0006`), no new column: map to the existing **`reactions`** channel (default digest), so a refresh event never sends an instant email by default. Alternative: `direct` (instant). Recommend `reactions`. Master switch and `off` apply as usual.

## 7. Volume cap (RULING 5)
A per-author ceiling, proposed 20 reference notifications per rolling day, extra ones dropped (not queued). Pure insurance against one popular resource used across many posts.

## 8. What turning the sweep on changes
`REFERENCE_REFRESH` "0" to "1" (ROADMAP R11, PM's say-so) is what creates events at all, so M3.9 ships **dark behind the same flag** and must be merged, with its migration applied by the PM, **before** the flip. No flip PR until then. Spending is unchanged (the per-author budget already pays per look). The rollback-check workflow still has no runs, so `AUTO_ROLLBACK_ENABLED` stays unrequested.

## 9. Tests to pin it (red first)
`unknown` writes nothing; first look writes nothing; `gone` notifies each live author once; `changed` twice with the same hash notifies once, with a new hash again; `resolved` notifies nobody; a draft, a removed post and a moderated post notify nobody; the cap; the flag off writes nothing.

## 10. Rulings needed from CireSnave/PM
1 recipients; 2 states (esp. `resolved`); 3 schema A or B; 4 channel; 5 cap. Everything else is mechanical.
