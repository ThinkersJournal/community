# M2.3c — Email Notifications: Design

**Status:** Approved (brainstorm complete 2026-07-31)
**Milestone:** M2.3c (third slice of M2.3 notifications; follows M2.3a core, M2.3b realtime bell, M2.3b-live per-post live)
**Branch:** `m2-3c-email` off `main`

## Goal

Deliver notification events to users by email, so the platform reaches people who
are not currently on the site — the whole point of email over the in-app bell.
Each user controls delivery per category; email that would be redundant with what
they already saw in-app is suppressed.

## Architecture (one sentence)

The `notifications` table doubles as a durable email **outbox**: two Cloudflare
Cron triggers drive one `scheduled()` handler that drains not-yet-emailed,
still-unread rows — every 2 minutes for *instant*-disposition rows, once daily for
*digest*-disposition rows — coalescing each recipient's rows into one Postmark
send on a dedicated Broadcast stream, stamping `emailed_at` only on success.

---

## Decision log (from the brainstorm)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Delivery model | Per-category prefs: **direct / reactions / follows**, each `{instant\|digest\|off}`, plus a global **master switch** |
| 2 | Category defaults | direct = **instant**; reactions = **digest**; follows = **digest**; master = **on** |
| 3 | Digest cadence | **Daily**, fixed **14:00 UTC** |
| 4 | Instant send path | **Unified outbox on `notifications`** — the row is the queue; `emailed_at` is the watermark; two crons, one handler |
| 5 | Read-suppression | Email **only what is still unread** (`read_at IS NULL`) at send time; the ~2-min instant delay is the suppression window |
| 6 | Unsubscribe scope | One-click (RFC 8058) turns off **all** notification email (master off); granular control is in-app |
| 7 | Unsubscribe token | **HMAC-signed, stateless** (no storage); one new Workers secret |
| 8 | Sending isolation | Separate Postmark **Broadcast stream**, same domain (`noreply@thinkersjournal.com`); dedicated subdomain deferred |
| 9 | `read_at` semantics | **Click-through only** — opening the bell no longer marks everything read |
| 10 | Badge model | Decouple **seen** (badge) from **read** (email): new `seen_at` watermark clears the badge on open; `read_at` drives email suppression |

---

## What already exists (reused, not rebuilt)

- **`notify()` write seam** (`apps/api/src/notifications/create.ts`) — the single birth
  point of a notification row. Already `ON CONFLICT DO NOTHING`, `rowCount`-gated,
  fires the content-free DO nudge via `ctx.waitUntil`. **Unchanged by this
  milestone** — it already writes the row that is now also the outbox entry.
- **`notifications` table** (`migrations/0005_notifications.sql`) — id (uuidv7),
  recipient_id, actor_id, kind, post_id, comment_id, reaction_kind, created_at,
  `read_at`. This milestone adds columns, not a new table for events.
- **Shared pure copy helpers** (`packages/shared/src/notifications.ts`) —
  `collapseNotifications`, `notificationLabel`, `notificationHref`. The email body
  reuses these verbatim so email, the bell, and the `/notifications` page cannot
  disagree on wording or link targets.
- **Postmark send** (`apps/api/src/auth/email-verify.ts` → `sendVerificationEmail`) —
  never-throws, `escapeHtml`, `From: noreply@thinkersjournal.com`. This milestone
  extracts the generic transport and adds a second caller.
- **Mark-read route** (`apps/api/src/routes/notifications.ts` → `handleMarkRead`) —
  already supports both `{all:true}` and `{ids:[...]}`. Click-through needs only a
  new *caller*, not a new route branch.
- **The bell island** (`apps/web/src/scripts/notify-bell.ts`) — `openPanel`
  currently POSTs `{all:true}` on open (the behavior this milestone changes).

---

## Section 1 — Data model

### 1a. Enum + prefs/state table

New enum and one table holding **all** per-user notification settings *and* the
seen watermark. **Absent row = defaults** (no signup backfill; queries `LEFT JOIN`
and `COALESCE`).

```sql
CREATE TYPE notification_channel AS ENUM ('instant', 'digest', 'off');

CREATE TABLE notification_prefs (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  master_enabled boolean              NOT NULL DEFAULT true,
  direct         notification_channel NOT NULL DEFAULT 'instant',
  reactions      notification_channel NOT NULL DEFAULT 'digest',
  follows        notification_channel NOT NULL DEFAULT 'digest',
  -- Badge watermark (decision 10). NULL = never opened the bell = everything unseen.
  seen_at        timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
```

Rationale for one table (not `notification_email_prefs` + a separate seen row): both
are small, per-user, always queried together for the badge/send paths, and both
follow the same absent-row-means-default rule. Naming it `notification_prefs`
(not `..._email_prefs`) because it now also holds the badge watermark.

### 1b. Outbox watermark column

```sql
ALTER TABLE notifications ADD COLUMN emailed_at timestamptz;  -- NULL = not yet emailed
```

### 1c. Indexes

```sql
-- The outbox drain predicate: unsent AND unread, newest first for coalescing.
CREATE INDEX notifications_outbox_idx
  ON notifications (recipient_id, created_at)
  WHERE emailed_at IS NULL AND read_at IS NULL;

-- The unseen badge count (created_at > seen_at). The existing
-- notifications_recipient_id_desc_idx (recipient_id, id DESC) already covers
-- recipient scoping; this partial index keeps the drain scan cheap.
```

> **Migration files:** `migrations/0006_notification_prefs.sql` (enum + table),
> `migrations/0007_notifications_emailed_at.sql` (column + index). Two files so each
> is independently reversible; both ship in this milestone.

---

## Section 2 — Preferences & disposition resolution

**Category → kind mapping** (a pure helper in `packages/shared`, single source):

| Category | Kinds |
|----------|-------|
| `direct` | `post_comment`, `comment_reply` |
| `reactions` | `post_reaction`, `comment_reaction` |
| `follows` | `follow` |

**Disposition** is resolved **at send time** from *current* prefs (so a pref change
takes effect on the next pass, not frozen at write time). A row is **emailable in a
given pass** iff **all** hold:

1. `master_enabled = true` (default true when no prefs row)
2. the row's category channel = the pass's disposition (`instant` for the 2-min
   pass, `digest` for the daily pass) — default per decision 2 when no prefs row
3. recipient `email_verified_at IS NOT NULL` — **never email an unverified address**
4. `read_at IS NULL` (decision 5 — click-through suppression)
5. `emailed_at IS NULL` (not already sent)

Shared helper (pure, no zod — same bundle discipline as the rest of
`notifications.ts`):

```ts
// packages/shared/src/notifications.ts
export type NotificationCategory = "direct" | "reactions" | "follows";
export function categoryForKind(kind: NotificationKind): NotificationCategory;
```

---

## Section 3 — Seen/read decoupling (bell behavior change)

This is a **change to shipped M2.3a/b behavior**, required for email correctness.

### API

- **New** `POST /api/notifications-seen` (api: `handleMarkSeen`) — upserts the
  caller's `notification_prefs` row setting `seen_at = now()`. Full
  origin+CSRF+epoch pipeline (like `handleMarkRead`), `requireVerifiedEmail: false`
  (an unverified user must still clear their own badge). Fires a `"read"`-style
  content-free DO nudge (rename the nudge concept to a generic "refresh" is **not**
  required — reuse the existing `"read"` kind; other tabs only ever refetch) via
  `ctx.waitUntil`, gated on `rowCount > 0`.
- **`handleUnreadCount`** changes from `WHERE read_at IS NULL` to the **unseen**
  predicate:
  ```sql
  SELECT count(*) n
    FROM notifications n
    LEFT JOIN notification_prefs np ON np.user_id = n.recipient_id
   WHERE n.recipient_id = $1
     AND n.created_at > COALESCE(np.seen_at, 'epoch'::timestamptz);
  ```
- **`handleMarkRead`** is unchanged (still supports `{ids}` and `{all}`); it now has
  a real click-through caller.

### Bell island (`notify-bell.ts`)

- `openPanel`: **remove** the `POST {all:true}` on open. Instead POST
  `POST /api/notifications-seen` after a successful render (same CSRF-token idiom,
  same degraded-mode skip when no token). On success, clear the badge locally.
- **New click-through wiring:** when a rendered group's anchor is clicked, POST
  `POST /api/notifications-read {ids: group.ids}` (fire-and-forget, before/at
  navigation) so that group's `read_at` is set. The row's `.unread` styling
  (line 117) now reflects click-through read state.
- The live WS nudge and the 60s poll continue to drive `refreshCount` (now
  unseen-based). No reconnect/latch changes.

### `/notifications` full page

- **Verified:** the page currently does **not** mark read on load — it only fetches
  and renders (`notifications.astro:40-43`). So **no functional change** is needed;
  its `.unread` styling (`card unread`, line 83) now simply reflects click-through
  read state (more rows will read as unread than before, which is correct).
- Advancing `seen_at` is the **bell-open's** job, not this page's. A user who reads
  via this page without opening the bell may see the badge linger until their next
  bell-open; that self-heals and is not worth a GET-with-side-effect here.
- A bulk "Mark all read" button (backed by the existing `{all:true}`) is an optional
  convenience — **deferred**, not part of this milestone.

### Tests to update

`e2e/notifications-realtime.spec.ts`, `apps/api/test/notifications.test.ts`, and any
DO test asserting "open marks all read" must move to the seen/read split.

---

## Section 4 — Outbox drain (`scheduled()` handler)

### Cron triggers (`apps/api/wrangler.jsonc` — api's FIRST Cron trigger)

```jsonc
"triggers": { "crons": ["*/2 * * * *", "0 14 * * *"] }
```

### Handler

`apps/api/src/index.ts` gains a `scheduled` export alongside `fetch`:

```ts
export default {
  async fetch(...) { ... },
  async scheduled(controller, env, ctx) {
    // controller.cron is the exact matched pattern string.
    const disposition = controller.cron === "0 14 * * *" ? "digest" : "instant";
    ctx.waitUntil(runEmailDrain(env, disposition));
  },
} satisfies ExportedHandler<Env>;
```

`runEmailDrain(env, disposition)` lives in a new
`apps/api/src/notifications/email-drain.ts`. Uses **`HYPERDRIVE_FRESH`**
(consistent, uncached — this reads current prefs and writes `emailed_at`).

### Single-flight guard

A long pass must not overlap the next tick and double-send. At pass start:

```sql
SELECT pg_try_advisory_lock($lockKey);   -- distinct key per disposition
```

If not acquired, log and return (another pass of this disposition is in flight).
Release with `pg_advisory_unlock` in a `finally`. This mirrors the single-flight
discipline used in the live-reconcile client.

### Selection, coalescing, send, stamp

1. **Select** eligible rows (Section 2 predicate for this disposition), joined to
   actor profile + post title/slug + recipient email, ordered by
   `recipient_id, created_at`. (Same column set the bell list query already
   projects — reuse the shape so `collapseNotifications` accepts it.)
2. **Group by recipient.** For each recipient, `collapseNotifications` their rows →
   build **one** email (Section 5).
3. **Send** via `sendNotificationEmail` (Section 6).
4. **Stamp `emailed_at = now()` ONLY on a successful send**, for exactly the row ids
   included in that email:
   ```sql
   UPDATE notifications SET emailed_at = now()
    WHERE id = ANY($ids::uuid[]) AND emailed_at IS NULL;
   ```
   A failed send (Postmark never-throws → detected via return value) leaves
   `emailed_at NULL`, so the next pass retries. **Retry-safe by construction.**

Per-recipient send failures are isolated — one bad address never blocks other
recipients in the same pass.

> **Scale note (deferred, documented):** at current volume a pass processes every
> eligible recipient in one invocation. If a pass ever risks exceeding the CPU/time
> budget, add a batch cursor (process N recipients, re-arm). Logged, not built.

---

## Section 5 — Email composition

A pure builder in `apps/api/src/notifications/email-content.ts` (api-side — it uses
`escapeHtml` and `CANONICAL_ORIGIN`) turns a recipient's collapsed groups into
`{subject, textBody, htmlBody}`, reusing
`collapseNotifications` / `notificationLabel` / `notificationHref` so the wording
matches the bell exactly.

- **Instant** (2-min pass): usually one group; coalesces a burst.
  - Subject (1 group): the label sentence, e.g. `Ada commented on your post «On Method»`.
  - Subject (N groups): `You have N new notifications`.
- **Digest** (daily): `Your Thinkers Journal digest — N updates`, body is the grouped
  list.
- Every notification line links to its target via `notificationHref`, absolutized
  against `CANONICAL_ORIGIN` (`https://community.thinkersjournal.com`). `null` href
  (deleted post) → plain text, same as the bell.
- All interpolation through `escapeHtml`. Footer: the unsubscribe line (Section 7)
  and a "manage preferences" link to `/settings/notifications`.

---

## Section 6 — Postmark send refactor

Extract the generic transport from `sendVerificationEmail`:

```ts
// apps/api/src/auth/postmark.ts  (moved/extracted; email-verify.ts imports it)
interface PostmarkMessage {
  from: string; to: string; subject: string;
  textBody: string; htmlBody: string;
  stream: string;                         // "outbound" | "broadcast"
  headers?: { Name: string; Value: string }[];   // e.g. List-Unsubscribe
}
export async function postmarkSend(env: Env, msg: PostmarkMessage): Promise<boolean>;
// returns true on a confirmed accept (2xx AND ErrorCode 0); false otherwise.
// NEVER THROWS. NEVER logs `to`/body/token — same rule as today.
```

- `sendVerificationEmail` becomes a thin wrapper: `stream: "outbound"`, unchanged
  behavior and log discipline.
- **New** `sendNotificationEmail(env, {to, subject, textBody, htmlBody, unsubUrl})`:
  `stream: "broadcast"`, `From: noreply@thinkersjournal.com`, adds the RFC 8058
  headers (Section 7). Returns the boolean the drain uses to decide whether to
  stamp `emailed_at`.

> **Deploy-time:** create the Broadcast message stream in Postmark (documented like
> the Hyperdrive/KV placeholders). Until it exists, broadcast sends return an
> `ErrorCode` → `postmarkSend` returns false → rows retry (no data loss, no crash).

---

## Section 7 — Unsubscribe (RFC 8058)

### Headers (on every notification email)

```
List-Unsubscribe: <https://community.thinkersjournal.com/unsub?token=…>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

> **No `mailto:` variant.** RFC 8058 permits a `mailto:` alongside the https URL,
> but we have no inbound-mail processor — a `mailto:` unsubscribe would land in an
> unmonitored inbox and silently fail. A single working https one-click URL is
> better than one that works plus one that doesn't. (If inbound processing is added
> later, the `mailto:` can be reintroduced.)

### Token — HMAC-signed, stateless

`apps/api/src/notifications/unsub-token.ts`:

```ts
// token = base64url(userId) + "." + base64url(HMAC_SHA256(userId, UNSUBSCRIBE_SIGNING_KEY))
export async function mintUnsubToken(env: Env, userId: string): Promise<string>;
export async function verifyUnsubToken(env: Env, token: string): Promise<string | null>; // userId | null
```

- Web Crypto `crypto.subtle` HMAC; **constant-time** compare on verify.
- No storage, idempotent, never expires — correct for an unsubscribe link.
- One new Workers secret: **`UNSUBSCRIBE_SIGNING_KEY`** (add to `.dev.vars`,
  `worker-configuration.d.ts` via `wrangler types`, and the deploy secret list).

### Endpoints

api (`apps/api/src/routes/unsub.ts`), **outside** the CSRF/session pipeline — the
token *is* the auth, requests come cross-origin from mail providers with no cookie:

- `POST /unsub` (one-click): verify token → `UPDATE notification_prefs … SET
  master_enabled = false` (upsert). Return `200` (empty). No CSRF (RFC 8058
  one-click cannot carry one); the action is strictly limited to setting
  `master_enabled=false` for the token's user — no escalation possible.
- `GET /unsub?token=…`: same idempotent unsubscribe, then render a confirmation
  (older clients GET the URL). Served through the web proxy so it has a public
  origin.

web (`apps/web/src/pages/unsub.astro` + proxy): `GET /unsub` renders "You've been
unsubscribed from all notification emails. Manage preferences →
`/settings/notifications`." and calls api; `POST /unsub` proxies one-click to api.

Invalid/tampered token → generic `200`/neutral page (never reveal validity; never
error). Unsubscribe is fully idempotent.

---

## Section 8 — In-app settings surface

- **web** `apps/web/src/pages/settings/notifications.astro` — authed, `no-store`,
  viewer-scoped (same pattern as `/notifications`). Renders the master toggle + three
  `{instant|digest|off}` selects (Direct / Reactions / Follows). This is where a
  one-click-unsubscribed user re-enables (`master_enabled=true`).
- **api** `apps/api/src/routes/notification-prefs.ts`:
  - `GET /notification-prefs` → current effective prefs (defaults when no row).
  - `PUT /notification-prefs` → upsert (full origin+CSRF+epoch;
    `requireVerifiedEmail: false` so an unverified user can still opt out). zod
    `NotificationPrefsInput` in a `notifications-prefs` shared module (zod isolated
    from the pure bell bundle, same split as `MarkReadInput`).
- **web** proxies `/api/notification-prefs` (GET/PUT).

---

## Section 9 — Security & correctness invariants

1. **Never email an unverified address** — `email_verified_at IS NOT NULL` gate in
   the drain (Section 2.3). Defense in depth: the address only exists on a user row.
2. **Never log `to`, email body, tokens, or unsub tokens** — carry only
   status/ErrorCode/Message, same as today's Postmark discipline.
3. **`/unsub` bypasses CSRF/session** deliberately (token-authed, cross-origin) and
   its only possible effect is `master_enabled=false` for the token's user. No IDOR:
   the userId comes from the *verified* HMAC payload, never a query field.
4. **`emailed_at` stamped only on confirmed send** — no silent drops; failures retry.
5. **Advisory-lock single-flight** prevents overlapping passes double-sending.
6. **HTML injection**: all user-derived text (`escapeHtml`) — actor names, post
   titles — same vector the verification email already guards.
7. **Read-suppression is best-effort by design**: a race where a user clicks through
   in the same instant the pass reads can send one already-read email. Harmless
   (idempotent-ish annoyance), and strictly bounded by the 2-min window.

---

## Section 10 — Testing strategy

- **Unit (pure):** `categoryForKind`; disposition/eligibility resolver (master-off,
  each channel, verified gate, unread gate, emailed gate); HMAC token
  mint→verify round-trip + tamper-reject + wrong-key reject; email-content builder
  from fixtures (instant 1-group / instant N-group / digest); unseen-count SQL shape.
- **`cloudflare:test` (Workers runtime):** `scheduled()` drain end-to-end against
  the test DB — instant vs digest selection by disposition; per-recipient
  coalescing into one send; `emailed_at` stamped only after a stubbed **successful**
  send and left NULL after a stubbed **failed** send (retry on next pass);
  advisory-lock single-flight (a second concurrent pass sends nothing);
  self/unverified/read/off/master-off suppression each proven; `/unsub` GET+POST
  flip `master_enabled`; `/notification-prefs` GET defaults + PUT upsert;
  `/notifications-seen` sets `seen_at` and the count goes to 0.
- **e2e (Playwright):** settings page saves prefs and reflects them; the gated
  `__test` Postmark stub asserts a notification send fired for an away user and did
  **not** fire when the recipient clicked through within the window; bell badge
  clears on open (seen) but rows stay bold until click-through (read).

The dev harness's `postmark send failed` (dummy token) and `cache.purge is not a
function` (miniflare) lines remain expected artifacts.

---

## Section 11 — New infra / config (deploy-time, placeholder pattern)

| Item | Where | Note |
|------|-------|------|
| `triggers.crons` | `wrangler.jsonc` | api's first Cron trigger; `["*/2 * * * *", "0 14 * * *"]` |
| `UNSUBSCRIBE_SIGNING_KEY` | Workers secret | `.dev.vars` for local; `wrangler secret put` at deploy; regenerate `worker-configuration.d.ts` |
| Postmark **Broadcast** stream | Postmark dashboard | create at deploy; broadcast sends return ErrorCode until it exists → rows retry, no crash |
| `notification_channel` enum + `notification_prefs` + `emailed_at` | migrations 0006, 0007 | run in CI/deploy migration step |

No new DO namespace, no new KV, no new binding — the outbox reuses Postgres.

---

## Section 12 — Build order (for writing-plans)

1. **Migrations** — `notification_channel` enum, `notification_prefs` table,
   `notifications.emailed_at` + outbox index (0006, 0007) + schema tests.
2. **Shared helpers** — `categoryForKind`, `NotificationCategory`; disposition/
   eligibility resolver; `NotificationPrefsInput` zod (isolated module).
3. **Prefs API** — `GET`/`PUT /notification-prefs` (upsert, defaults) + web proxy.
4. **Seen/read decoupling** — `POST /notifications-seen`; `handleUnreadCount` →
   unseen; bell island (drop open-marks-read, add seen POST + click-through read
   POST); update shipped tests.
5. **Postmark refactor** — extract `postmarkSend`; rewrap `sendVerificationEmail`;
   add `sendNotificationEmail` (broadcast stream + headers).
6. **Unsub token + endpoints** — HMAC mint/verify; api `/unsub` (GET/POST);
   web `/unsub` page+proxy; `UNSUBSCRIBE_SIGNING_KEY`.
7. **Email content builder** — instant/digest subject+body from collapsed groups.
8. **Outbox drain + cron** — `runEmailDrain`; `scheduled` export; advisory lock;
   coalesce; stamp-on-success; `triggers.crons`.
9. **Settings page** — `/settings/notifications` web UI over the prefs API.
10. **e2e spine** — away-user gets email; click-through suppresses; badge/seen vs
    read split.

Whole-branch adversarial review (Ultracode) at milestone end; CI-gated PR → merge.

---

## Section 13 — Deferred / future (documented, not built)

- **Dedicated sending subdomain** (`notifications.thinkersjournal.com`, own
  DKIM/SPF/DMARC) — graduate from the shared-domain broadcast stream when volume
  warrants; note the reputation re-warming cost.
- **Per-recipient batch cursor** in the drain if a pass outgrows one invocation.
- **Bounce/complaint webhook** handling (Postmark → suppress hard-bounced addresses).
- **Attempt counter** so a permanently-failing address stops retrying every pass.
- **Timezone-aware or per-user digest cadence** (currently fixed 14:00 UTC daily).

## Section 14 — Out of scope

Push/mobile notifications; SMS; per-post or per-thread mute; notification email for
kinds outside the five existing (`post_comment`, `comment_reply`, `post_reaction`,
`comment_reaction`, `follow`); digest for *instant*-disposition kinds (instant kinds
never fall through to the daily digest — they email on the 2-min pass or, if read
first, not at all).
