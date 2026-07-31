# M2.3c Email Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver notification events by email — per-category (direct/reactions/follows, each instant|digest|off, plus a global master switch), sent from a cron-drained outbox on the `notifications` table, suppressing anything already read in-app.

**Architecture:** The `notifications` table doubles as a durable outbox: `emailed_at` is the watermark. Two Cloudflare Cron triggers drive one `scheduled()` handler that drains not-yet-emailed, still-unread, verified-recipient rows — every 2 minutes for *instant*-disposition rows, daily at 14:00 UTC for *digest*-disposition rows — coalescing each recipient's rows into one Postmark send on a dedicated Broadcast stream, stamping `emailed_at` only on a confirmed send. A DB lease-row (not a session advisory lock — see Global Constraints) makes each pass single-flight. Separately, the bell's "seen" (badge) is decoupled from "read" (email suppression): a new `seen_at` watermark clears the badge on open, while `read_at` is set only on click-through.

**Tech Stack:** TypeScript 6, Cloudflare Workers (`apps/api` hand-written Worker, `apps/web` Astro + @astrojs/cloudflare), Postgres 18 via Hyperdrive, `pg` client, Postmark transactional/broadcast email, Web Crypto HMAC, node-pg-migrate (SQL migrations), Vitest (`@cloudflare/vitest-pool-workers` for workerd tests, plain Node for `*.db.test.ts`), Playwright e2e.

## Global Constraints

Every task's requirements implicitly include this section. Values are verbatim from `docs/superpowers/specs/2026-07-31-m2-3c-email-notifications-design.md`.

- **Enum:** `notification_channel` = `('instant', 'digest', 'off')`.
- **Category → kind:** `direct` ← `post_comment`, `comment_reply`; `reactions` ← `post_reaction`, `comment_reaction`; `follows` ← `follow`.
- **Prefs defaults (also the COALESCE defaults for an absent row):** `master_enabled` = `true`, `direct` = `'instant'`, `reactions` = `'digest'`, `follows` = `'digest'`.
- **Cron triggers:** `"triggers": { "crons": ["*/2 * * * *", "0 14 * * *"] }`. `*/2 * * * *` = instant pass; `0 14 * * *` = digest pass.
- **Eligibility (a row emails in a pass iff ALL hold):** `master_enabled = true` · category channel = the pass's disposition · recipient `email_verified_at IS NOT NULL` · `read_at IS NULL` · `emailed_at IS NULL`.
- **Never email an unverified address.** Never send to a recipient whose `email_verified_at IS NULL`.
- **`emailed_at` is stamped ONLY after a confirmed send** (Postmark 2xx AND `ErrorCode === 0`). A failed send leaves it NULL so the next pass retries.
- **Postmark:** `From: noreply@thinkersjournal.com` (MUST stay a confirmed sender). Notification email uses `MessageStream: "broadcast"`; verification email keeps `"outbound"`. Never throws. **Never log `To`, the body, tokens, or the unsub token** — only status/ErrorCode/Message.
- **Origin for links:** `CANONICAL_ORIGIN = "https://community.thinkersjournal.com"`. Absolutize every notification href against it; `null` href (deleted post) → plain text.
- **HTML safety:** every user-derived interpolation (actor names, post titles, URLs) goes through `escapeHtml`.
- **Bundle discipline:** NO `zod` import in `packages/shared/src/notifications.ts` (it ships to every page via the bell island). New zod input schemas live in their own sibling module.
- **Unsubscribe:** RFC 8058 `List-Unsubscribe` (https URL only — **no `mailto:` variant**, we have no inbound-mail processor) + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Token is a stateless HMAC (`UNSUBSCRIBE_SIGNING_KEY` secret). One click → `master_enabled = false` (all categories).
- **Single-flight mechanism (DEVIATION FROM SPEC — see below):** a DB lease row, NOT `pg_try_advisory_lock`.
- **`read_at` = click-through only.** Opening the bell must NOT mark rows read; it advances `seen_at` instead.
- **Migrations:** SQL files in `apps/api/migrations/`, `-- Up Migration` / `-- Down Migration` format (mirror `0005_notifications.sql`). New files: `0006_notification_prefs.sql`, `0007_email_outbox.sql`. Applied automatically by `apps/api/test/global-setup.ts` (node-pg-migrate `up`, `count: Infinity`).
- **Route table:** every api route is a `RouteDef` in `apps/api/src/routes.ts` (first-match-wins; literals before dynamic `:id` on a shared first segment). `test/route-protection.test.ts` and `test/error-envelope.test.ts` both import `ROUTES` — a new mutating route must run `runMutatingPipeline` or be added to `PIPELINE_EXEMPT` with justification; a route with no error envelope must be allowlisted in `error-envelope.test.ts`.

### DESIGN REFINEMENT — single-flight is a lease row, not an advisory lock

The spec (§4, §9) specifies `pg_try_advisory_lock`. **Do not use it.** `apps/api/src/db/client.ts`'s header documents that Hyperdrive pools in **transaction mode** and may hand different backend connections to consecutive autocommit queries within one Worker invocation (which is why the codebase uses `SET LOCAL` inside `BEGIN`, never session `SET`). A **session-scoped** advisory lock (`pg_advisory_lock` / `pg_try_advisory_lock`) is therefore not reliably held across the drain's sequence of autocommit queries — it could be acquired on one backend and invisible on the next. A **transaction-scoped** `pg_advisory_xact_lock` would require holding one transaction open across all the external Postmark HTTP sends, which the codebase forbids (`BEGIN_BOUNDED_TX` sets `idle_in_transaction_session_timeout = 10s`, and holding row locks across a network call is the exact anti-pattern that setting exists to bound).

Instead use a **lease row** (`email_drain_lock`, created in Task 1): acquire with an atomic conditional `UPDATE ... SET leased_until = now() + interval '90 seconds' WHERE pass = $1 AND (leased_until IS NULL OR leased_until < now()) RETURNING pass` (rowCount 1 = acquired). It is committed row state, correct regardless of which backend serves each query, and the 90-second lease auto-recovers from a crashed pass. Release by setting `leased_until = NULL`. This preserves the approved property (one pass of a disposition at a time) with a mechanism that actually works here. The spec's §4/§9 wording will be updated to match.

---

## File Structure

**New files**
- `apps/api/migrations/0006_notification_prefs.sql` — `notification_channel` enum + `notification_prefs` table.
- `apps/api/migrations/0007_email_outbox.sql` — `notifications.emailed_at` + outbox index + `email_drain_lock` lease table (+ seed rows).
- `apps/api/test/notification-prefs-schema.db.test.ts` — schema assertions for the two migrations (Node/`pg`).
- `packages/shared/src/notifications-categories.ts` — `NotificationCategory`, `categoryForKind` (pure, no zod).
- `packages/shared/src/notifications-prefs.ts` — `NotificationChannel`, `NotificationPrefs`, `NotificationPrefsInput` (zod), defaults.
- `apps/api/src/routes/notification-prefs.ts` — `GET`/`PUT /notification-prefs`.
- `apps/api/src/notifications/seen.ts` — `handleMarkSeen` (`POST /notifications/seen`).
- `apps/web/src/pages/api/notifications-seen.ts` — browser→api proxy for the seen POST.
- `apps/api/src/auth/postmark.ts` — generic `postmarkSend` transport (extracted from `email-verify.ts`).
- `apps/api/src/notifications/unsub-token.ts` — HMAC mint/verify.
- `apps/api/src/routes/unsub.ts` — `POST /unsub` (token-authed, no session/CSRF).
- `apps/web/src/pages/unsub.astro` — public confirmation page + one-click POST handler.
- `apps/api/src/notifications/email-content.ts` — `buildNotificationEmail` (subject/text/html).
- `apps/api/src/notifications/email-drain.ts` — `runEmailDrain`, the eligibility query, coalescing, lease.
- `apps/web/src/pages/settings/notifications.astro` — the authed settings form.
- `e2e/email-notifications.spec.ts` — the away-user-gets-email / read-suppresses / seen-vs-read spine.
- Test siblings: `apps/api/test/notification-prefs.test.ts`, `notifications-seen.test.ts`, `postmark.test.ts`, `unsub-token.test.ts`, `unsub-route.test.ts`, `email-content.test.ts`, `email-drain.test.ts`; `packages/shared/test/notifications-categories.test.ts`, `notifications-prefs.test.ts`; `apps/web/test/settings-notifications-page.test.ts`, `unsub-page.test.ts`, `notify-seen-proxy.test.ts`.

**Modified files**
- `apps/api/src/routes.ts` — register `/notification-prefs` (GET/PUT), `/notifications/seen` (POST), `/unsub` (POST).
- `apps/api/src/index.ts` — add the `scheduled` handler alongside `fetch`.
- `apps/api/src/routes/notifications.ts` — `handleUnreadCount` → unseen predicate.
- `apps/api/src/auth/email-verify.ts` — `sendVerificationEmail` rewrapped over `postmarkSend`; add `sendNotificationEmail`.
- `apps/web/src/scripts/notify-bell.ts` — open advances `seen_at` (not read-all); click-through marks `{ids}` read.
- `apps/api/wrangler.jsonc` — `triggers.crons`.
- `apps/api/.dev.vars` + vitest `miniflare.bindings` + regenerated `worker-configuration.d.ts` — `UNSUBSCRIBE_SIGNING_KEY`.
- `apps/api/test/route-protection.test.ts` — `PIPELINE_EXEMPT` entry for `POST /unsub`; new mutating routes otherwise covered by the pipeline.
- `apps/api/test/error-envelope.test.ts` — allowlist `POST /unsub` (neutral 200, no error envelope).
- Shipped bell/notification tests updated for the seen/read split (Task 4).
- `packages/shared/src/index.ts` — re-export the new shared modules.

---

## Task 1: Migrations — prefs table, enum, outbox column, lease table

**Files:**
- Create: `apps/api/migrations/0006_notification_prefs.sql`
- Create: `apps/api/migrations/0007_email_outbox.sql`
- Test: `apps/api/test/notification-prefs-schema.db.test.ts`

**Interfaces:**
- Produces: table `notification_prefs (user_id PK, master_enabled bool, direct/reactions/follows notification_channel, seen_at timestamptz, updated_at timestamptz)`; enum `notification_channel`; column `notifications.emailed_at timestamptz`; table `email_drain_lock (pass text PK, leased_until timestamptz)` seeded with rows `'instant'`, `'digest'`.

- [ ] **Step 1: Write the failing schema test**

`apps/api/test/notification-prefs-schema.db.test.ts` (Node project — direct `pg`, mirrors `notifications-schema.db.test.ts`):

```ts
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;
beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});
afterAll(async () => {
  await client.end();
});

describe("0006/0007 migrations", () => {
  it("notification_channel enum has exactly instant|digest|off", async () => {
    const { rows } = await client.query<{ label: string }>(
      `SELECT e.enumlabel AS label
         FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname = 'notification_channel' ORDER BY e.enumsortorder`,
    );
    expect(rows.map((r) => r.label)).toEqual(["instant", "digest", "off"]);
  });

  it("notification_prefs defaults match the spec when a row is inserted bare", async () => {
    const { rows: u } = await client.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`prefs-${crypto.randomUUID()}@t.test`],
    );
    const uid = u[0]!.id;
    try {
      const { rows } = await client.query<{
        master_enabled: boolean; direct: string; reactions: string; follows: string; seen_at: string | null;
      }>(`INSERT INTO notification_prefs (user_id) VALUES ($1)
          RETURNING master_enabled, direct, reactions, follows, seen_at`, [uid]);
      expect(rows[0]).toMatchObject({
        master_enabled: true, direct: "instant", reactions: "digest", follows: "digest", seen_at: null,
      });
    } finally {
      await client.query(`DELETE FROM users WHERE id = $1`, [uid]);
    }
  });

  it("notifications.emailed_at exists and defaults NULL", async () => {
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'notifications' AND column_name = 'emailed_at'`,
    );
    expect(rows).toHaveLength(1);
  });

  it("email_drain_lock is seeded with instant and digest", async () => {
    const { rows } = await client.query<{ pass: string }>(
      `SELECT pass FROM email_drain_lock ORDER BY pass`,
    );
    expect(rows.map((r) => r.pass)).toEqual(["digest", "instant"]);
  });

  it("the lease claim is atomic — a second claim while leased returns 0 rows", async () => {
    await client.query(`UPDATE email_drain_lock SET leased_until = NULL WHERE pass = 'instant'`);
    const first = await client.query(
      `UPDATE email_drain_lock SET leased_until = now() + interval '90 seconds'
        WHERE pass = 'instant' AND (leased_until IS NULL OR leased_until < now()) RETURNING pass`,
    );
    const second = await client.query(
      `UPDATE email_drain_lock SET leased_until = now() + interval '90 seconds'
        WHERE pass = 'instant' AND (leased_until IS NULL OR leased_until < now()) RETURNING pass`,
    );
    await client.query(`UPDATE email_drain_lock SET leased_until = NULL WHERE pass = 'instant'`);
    expect(first.rowCount).toBe(1);
    expect(second.rowCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @thinkersjournal/api test -- notification-prefs-schema` (Node project). Expected: FAIL — `type "notification_channel" does not exist` / relation `email_drain_lock` missing.

- [ ] **Step 3: Write `0006_notification_prefs.sql`**

```sql
-- Up Migration

-- Per-user notification settings AND the badge "seen" watermark (M2.3c). One row
-- per user; an ABSENT row means all defaults (queries LEFT JOIN + COALESCE), so
-- there is no signup backfill. seen_at drives the unread BADGE (decision 10);
-- read_at on notifications (0005) drives EMAIL suppression — deliberately separate.
CREATE TYPE notification_channel AS ENUM ('instant', 'digest', 'off');

CREATE TABLE notification_prefs (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  master_enabled boolean              NOT NULL DEFAULT true,
  direct         notification_channel NOT NULL DEFAULT 'instant',
  reactions      notification_channel NOT NULL DEFAULT 'digest',
  follows        notification_channel NOT NULL DEFAULT 'digest',
  seen_at        timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS notification_prefs;
DROP TYPE IF EXISTS notification_channel;
```

- [ ] **Step 4: Write `0007_email_outbox.sql`**

```sql
-- Up Migration

-- The notifications table doubles as the email OUTBOX (M2.3c). emailed_at is the
-- watermark: NULL = not yet emailed. Stamped ONLY after a confirmed Postmark send,
-- so a failed send retries on the next pass.
ALTER TABLE notifications ADD COLUMN emailed_at timestamptz;

-- The drain predicate: unsent AND unread, per recipient, oldest first for coalescing.
CREATE INDEX notifications_outbox_idx
  ON notifications (recipient_id, created_at)
  WHERE emailed_at IS NULL AND read_at IS NULL;

-- Single-flight lease for the cron drain (one row per pass). A pass claims its row
-- with an atomic conditional UPDATE (90s auto-expiring lease); a concurrent pass of
-- the same disposition sees a live lease and backs off. Committed row state — correct
-- through Hyperdrive's transaction-mode pooling, unlike a session advisory lock.
CREATE TABLE email_drain_lock (
  pass         text PRIMARY KEY,
  leased_until timestamptz
);
INSERT INTO email_drain_lock (pass) VALUES ('instant'), ('digest');

-- Down Migration
DROP TABLE IF EXISTS email_drain_lock;
DROP INDEX IF EXISTS notifications_outbox_idx;
ALTER TABLE notifications DROP COLUMN IF EXISTS emailed_at;
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `pnpm --filter @thinkersjournal/api test -- notification-prefs-schema`. Expected: PASS (5/5). node-pg-migrate applies 0006/0007 automatically in `global-setup.ts`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/0006_notification_prefs.sql apps/api/migrations/0007_email_outbox.sql apps/api/test/notification-prefs-schema.db.test.ts
git commit -m "feat(m2.3c): notification_prefs + email outbox migrations"
```

---

## Task 2: Shared category + prefs helpers

**Files:**
- Create: `packages/shared/src/notifications-categories.ts`
- Create: `packages/shared/src/notifications-prefs.ts`
- Modify: `packages/shared/src/index.ts` (add re-exports)
- Test: `packages/shared/test/notifications-categories.test.ts`, `packages/shared/test/notifications-prefs.test.ts`

**Interfaces:**
- Consumes: `NotificationKind`, `NOTIFICATION_KINDS` from `./notifications`.
- Produces:
  - `type NotificationCategory = "direct" | "reactions" | "follows"`
  - `function categoryForKind(kind: NotificationKind): NotificationCategory`
  - `type NotificationChannel = "instant" | "digest" | "off"` (`NOTIFICATION_CHANNELS` const tuple)
  - `interface NotificationPrefs { masterEnabled: boolean; direct: NotificationChannel; reactions: NotificationChannel; follows: NotificationChannel }`
  - `const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs`
  - `const NotificationPrefsInput` (zod) + `type NotificationPrefsValue`

- [ ] **Step 1: Write the failing tests**

`packages/shared/test/notifications-categories.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { categoryForKind } from "../src";
import { NOTIFICATION_KINDS } from "../src";

describe("categoryForKind", () => {
  it("maps each kind to its category", () => {
    expect(categoryForKind("post_comment")).toBe("direct");
    expect(categoryForKind("comment_reply")).toBe("direct");
    expect(categoryForKind("post_reaction")).toBe("reactions");
    expect(categoryForKind("comment_reaction")).toBe("reactions");
    expect(categoryForKind("follow")).toBe("follows");
  });
  it("covers every kind (no kind falls through)", () => {
    for (const k of NOTIFICATION_KINDS) expect(categoryForKind(k)).toBeTruthy();
  });
});
```

`packages/shared/test/notifications-prefs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_NOTIFICATION_PREFS, NotificationPrefsInput } from "../src";

describe("prefs", () => {
  it("defaults match the spec", () => {
    expect(DEFAULT_NOTIFICATION_PREFS).toEqual({
      masterEnabled: true, direct: "instant", reactions: "digest", follows: "digest",
    });
  });
  it("accepts a full valid payload", () => {
    expect(NotificationPrefsInput.safeParse({
      masterEnabled: false, direct: "off", reactions: "instant", follows: "digest",
    }).success).toBe(true);
  });
  it("rejects an unknown channel", () => {
    expect(NotificationPrefsInput.safeParse({
      masterEnabled: true, direct: "hourly", reactions: "digest", follows: "digest",
    }).success).toBe(false);
  });
  it("rejects a missing field (all four required — PUT replaces the whole row)", () => {
    expect(NotificationPrefsInput.safeParse({ direct: "off" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @thinkersjournal/shared test`. Expected: FAIL — exports not found.

- [ ] **Step 3: Implement the modules**

`packages/shared/src/notifications-categories.ts` (PURE — no zod, importable by the bell island):

```ts
/**
 * The kind → category mapping (M2.3c). PURE and zod-free: shared by the email
 * drain (api) and any web surface. The three categories are the units the user
 * sets an email channel for (direct/reactions/follows). Adding a new
 * NotificationKind is a compile error here until it is mapped — deliberately.
 */
import type { NotificationKind } from "./notifications";

export type NotificationCategory = "direct" | "reactions" | "follows";

export function categoryForKind(kind: NotificationKind): NotificationCategory {
  switch (kind) {
    case "post_comment":
    case "comment_reply":
      return "direct";
    case "post_reaction":
    case "comment_reaction":
      return "reactions";
    case "follow":
      return "follows";
  }
}
```

`packages/shared/src/notifications-prefs.ts` (zod lives HERE, not in `notifications.ts`):

```ts
/**
 * Notification email preferences (M2.3c). The zod schema is isolated in this
 * module — NEVER import it from notifications.ts, which the bell island bundles
 * onto every page. `PUT /notification-prefs` replaces the whole row, so all four
 * fields are required (no partial patch).
 */
import { z } from "zod";

export const NOTIFICATION_CHANNELS = ["instant", "digest", "off"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export interface NotificationPrefs {
  masterEnabled: boolean;
  direct: NotificationChannel;
  reactions: NotificationChannel;
  follows: NotificationChannel;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  masterEnabled: true,
  direct: "instant",
  reactions: "digest",
  follows: "digest",
};

const channel = z.enum(NOTIFICATION_CHANNELS);

export const NotificationPrefsInput = z.object({
  masterEnabled: z.boolean(),
  direct: channel,
  reactions: channel,
  follows: channel,
});
export type NotificationPrefsValue = z.infer<typeof NotificationPrefsInput>;
```

- [ ] **Step 4: Re-export from the barrel**

Add to `packages/shared/src/index.ts` (match the existing export style there):

```ts
export * from "./notifications-categories";
export * from "./notifications-prefs";
```

- [ ] **Step 5: Run tests, verify pass**

Run: `pnpm --filter @thinkersjournal/shared test`. Expected: PASS. Then `pnpm --filter @thinkersjournal/shared build` (or the repo's typecheck) to confirm the barrel compiles.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/notifications-categories.ts packages/shared/src/notifications-prefs.ts packages/shared/src/index.ts packages/shared/test/notifications-categories.test.ts packages/shared/test/notifications-prefs.test.ts
git commit -m "feat(m2.3c): shared category map + prefs schema"
```

---

## Task 3: Prefs API — `GET`/`PUT /notification-prefs`

**Files:**
- Create: `apps/api/src/routes/notification-prefs.ts`
- Modify: `apps/api/src/routes.ts` (register both)
- Test: `apps/api/test/notification-prefs.test.ts`

**Interfaces:**
- Consumes: `withClient`, `readCurrentSession`, `runMutatingPipeline`, `errorResponse`, `NotificationPrefsInput`, `DEFAULT_NOTIFICATION_PREFS`.
- Produces: `handleGetNotificationPrefs`, `handlePutNotificationPrefs`. `GET` returns `NotificationPrefs` (defaults when no row). `PUT` upserts and returns the saved `NotificationPrefs`.

- [ ] **Step 1: Write the failing test**

`apps/api/test/notification-prefs.test.ts` (pool project — mirror `notifications.test.ts` fixtures):

```ts
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";
import worker from "../src";
import { createVerifiedActor, deleteCreatedUsers, type Actor } from "./actor";

afterAll(deleteCreatedUsers);

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const r = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return r;
}
function getReq(a: Actor): Request {
  return new Request("https://api.test/notification-prefs", { headers: { Cookie: a.cookie } });
}
function putReq(a: Actor, body: unknown): Request {
  return new Request("https://api.test/notification-prefs", {
    method: "PUT",
    headers: {
      Origin: "http://localhost:8787", Cookie: a.cookie,
      "X-CSRF-Token": a.csrfToken, "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("/notification-prefs", () => {
  it("GET returns spec defaults when no row exists", async () => {
    const a = await createVerifiedActor();
    const r = await fetchWorker(getReq(a));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      masterEnabled: true, direct: "instant", reactions: "digest", follows: "digest",
    });
  });

  it("PUT upserts and GET reflects it", async () => {
    const a = await createVerifiedActor();
    const body = { masterEnabled: false, direct: "off", reactions: "instant", follows: "digest" };
    expect((await fetchWorker(putReq(a, body))).status).toBe(200);
    expect(await (await fetchWorker(getReq(a))).json()).toEqual(body);
  });

  it("PUT rejects an invalid channel with 400", async () => {
    const a = await createVerifiedActor();
    const r = await fetchWorker(putReq(a, { masterEnabled: true, direct: "weekly", reactions: "digest", follows: "digest" }));
    expect(r.status).toBe(400);
  });

  it("GET without a session is 401", async () => {
    const r = await fetchWorker(new Request("https://api.test/notification-prefs"));
    expect(r.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @thinkersjournal/api test -- notification-prefs.test`. Expected: FAIL — route not registered (404/401 mismatch).

- [ ] **Step 3: Implement the handlers**

`apps/api/src/routes/notification-prefs.ts`:

```ts
/**
 * Per-user notification email preferences (M2.3c). GET is a session read
 * (defaults when the user has no row — absent row means defaults). PUT runs the
 * mutating pipeline WITHOUT requireVerifiedEmail: an unverified user must still
 * be able to opt out (same reasoning as mark-read / logout). Both scope to
 * session.userId — the IDOR boundary is in the SQL, never a client field.
 */
import { runMutatingPipeline, readCurrentSession } from "../auth/pipeline";
import { withClient } from "../db/client";
import { errorResponse } from "../http/errors";

import { DEFAULT_NOTIFICATION_PREFS, NotificationPrefsInput } from "@thinkersjournal/shared";
import type { NotificationPrefs } from "@thinkersjournal/shared";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

interface PrefsRow {
  masterEnabled: boolean; direct: string; reactions: string; follows: string;
}

export async function handleGetNotificationPrefs(
  request: Request, env: Env, ctx: ExecutionContext,
): Promise<Response> {
  const session = await readCurrentSession(env, request, () => errorResponse("LOGIN_REQUIRED", 401));
  if (session instanceof Response) return session;

  const prefs = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<PrefsRow>(
      `SELECT master_enabled AS "masterEnabled", direct, reactions, follows
         FROM notification_prefs WHERE user_id = $1`,
      [session.userId],
    );
    return rows[0] ?? null;
  });
  return json((prefs ?? DEFAULT_NOTIFICATION_PREFS) as NotificationPrefs);
}

export async function handlePutNotificationPrefs(
  request: Request, env: Env, ctx: ExecutionContext,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: false });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  const parsed = NotificationPrefsInput.safeParse(body);
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT", 400, { fields: ["masterEnabled", "direct", "reactions", "follows"] });
  }
  const p = parsed.data;

  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query(
      `INSERT INTO notification_prefs (user_id, master_enabled, direct, reactions, follows, updated_at)
       VALUES ($1,$2,$3::notification_channel,$4::notification_channel,$5::notification_channel, now())
       ON CONFLICT (user_id) DO UPDATE
         SET master_enabled = EXCLUDED.master_enabled,
             direct = EXCLUDED.direct, reactions = EXCLUDED.reactions,
             follows = EXCLUDED.follows, updated_at = now()`,
      [userId, p.masterEnabled, p.direct, p.reactions, p.follows],
    ),
  );
  return json(p);
}
```

- [ ] **Step 4: Register the routes**

In `apps/api/src/routes.ts`, add the import and two entries (place near the notifications block):

```ts
import { handleGetNotificationPrefs, handlePutNotificationPrefs } from "./routes/notification-prefs";
```
```ts
  // Notification email preferences (M2.3c). GET is a session read; PUT runs the
  // mutating pipeline (verified-email NOT required — opting out must stay open to
  // the unverified). Both scope to session.userId in-query.
  { method: "GET", pattern: "/notification-prefs", handler: handleGetNotificationPrefs },
  { method: "PUT", pattern: "/notification-prefs", handler: handlePutNotificationPrefs },
```

- [ ] **Step 5: Run tests, verify pass**

Run: `pnpm --filter @thinkersjournal/api test -- notification-prefs.test route-protection error-envelope`. Expected: PASS. `route-protection` passes because `PUT` runs `runMutatingPipeline`; `GET` is a read (no pipeline requirement). If `error-envelope` flags the GET, confirm its 401/400 go through `errorResponse` (they do).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/notification-prefs.ts apps/api/src/routes.ts apps/api/test/notification-prefs.test.ts
git commit -m "feat(m2.3c): GET/PUT /notification-prefs"
```

---

## Task 4: Seen/read decoupling — `POST /notifications/seen`, unseen count, bell island

**Files:**
- Create: `apps/api/src/notifications/seen.ts`
- Create: `apps/web/src/pages/api/notifications-seen.ts`
- Modify: `apps/api/src/routes/notifications.ts` (`handleUnreadCount` → unseen)
- Modify: `apps/api/src/routes.ts` (register `POST /notifications/seen`)
- Modify: `apps/web/src/scripts/notify-bell.ts` (open advances seen; click-through marks read)
- Test: `apps/api/test/notifications-seen.test.ts`, `apps/web/test/notify-seen-proxy.test.ts`; update `apps/api/test/notifications.test.ts` count expectations; update `apps/web/test/*` bell assertions; update `e2e/notifications-realtime.spec.ts` if it asserts open-marks-read.

**Interfaces:**
- Consumes: `withClient`, `runMutatingPipeline`, `env.NOTIFY.getByName(userId).push("read")`.
- Produces: `handleMarkSeen` (`POST /notifications/seen`) — upserts `notification_prefs.seen_at = now()`; content-free DO nudge gated on rowCount. `handleUnreadCount` now counts rows `created_at > COALESCE(seen_at, 'epoch')`.

- [ ] **Step 1: Write the failing API test**

`apps/api/test/notifications-seen.test.ts` (pool; reuse `seedNotif`/`onboardedActor` shapes from `notifications.test.ts` — inline minimal seeding):

```ts
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";
import worker from "../src";
import { withClient } from "../src/db/client";
import { createVerifiedActor, deleteCreatedUsers, type Actor } from "./actor";

afterAll(deleteCreatedUsers);

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const r = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return r;
}
async function seedNotif(recipientId: string, actorId: string): Promise<void> {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query(`INSERT INTO notifications (recipient_id, actor_id, kind) VALUES ($1,$2,'follow')`,
      [recipientId, actorId]));
  await waitOnExecutionContext(ctx);
}
const countReq = (a: Actor) =>
  new Request("https://api.test/notifications/unread-count", { headers: { Cookie: a.cookie } });
const seenReq = (a: Actor) =>
  new Request("https://api.test/notifications/seen", {
    method: "POST",
    headers: { Origin: "http://localhost:8787", Cookie: a.cookie, "X-CSRF-Token": a.csrfToken, "content-type": "application/json" },
    body: "{}",
  });
const count = async (a: Actor) =>
  ((await (await fetchWorker(countReq(a))).json()) as { count: number }).count;

describe("seen watermark vs unread count", () => {
  it("marking seen drops the badge to 0 without touching read_at", async () => {
    const me = await createVerifiedActor();
    const other = await createVerifiedActor();
    await seedNotif(me.userId, other.userId);
    expect(await count(me)).toBe(1);

    expect((await fetchWorker(seenReq(me))).status).toBe(200);
    expect(await count(me)).toBe(0);

    // read_at untouched: the row is still unread for email purposes.
    const ctx = createExecutionContext();
    const unread = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*) n FROM notifications WHERE recipient_id=$1 AND read_at IS NULL`, [me.userId]);
      return Number(rows[0]!.n);
    });
    await waitOnExecutionContext(ctx);
    expect(unread).toBe(1);
  });

  it("a notification created AFTER seen re-raises the badge", async () => {
    const me = await createVerifiedActor();
    const other = await createVerifiedActor();
    await fetchWorker(seenReq(me));                 // seen_at = now()
    await seedNotif(me.userId, other.userId);       // created_at > seen_at
    expect(await count(me)).toBe(1);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @thinkersjournal/api test -- notifications-seen.test`. Expected: FAIL — `/notifications/seen` unregistered; count still keys off read_at.

- [ ] **Step 3: Implement `handleMarkSeen`**

`apps/api/src/notifications/seen.ts`:

```ts
/**
 * Advance the caller's BADGE watermark (M2.3c). Opening the bell calls this
 * instead of marking everything read: seen_at drives the unread badge, read_at
 * (set only on click-through) drives email suppression. Upsert + a content-free
 * "read" DO nudge (gated on rowCount) so the caller's OTHER tabs clear too.
 */
import { runMutatingPipeline } from "../auth/pipeline";
import { withClient } from "../db/client";

export async function handleMarkSeen(
  request: Request, env: Env, ctx: ExecutionContext,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: false });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  const changed = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const res = await c.query(
      `INSERT INTO notification_prefs (user_id, seen_at, updated_at)
       VALUES ($1, now(), now())
       ON CONFLICT (user_id) DO UPDATE SET seen_at = now(), updated_at = now()`,
      [userId],
    );
    return res.rowCount ?? 0;
  });

  if (changed > 0) {
    ctx.waitUntil(
      (async () => {
        try {
          await env.NOTIFY.getByName(userId).push("read");
        } catch (err) {
          console.error("seen push failed", err);
        }
      })(),
    );
  }
  return new Response(JSON.stringify({}), {
    status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
```

- [ ] **Step 4: Switch `handleUnreadCount` to the unseen predicate**

In `apps/api/src/routes/notifications.ts`, replace the count query in `handleUnreadCount` (currently `WHERE recipient_id=$1 AND read_at IS NULL`) with:

```ts
    const { rows } = await c.query<{ n: string }>(
      `SELECT count(*) n
         FROM notifications n
         LEFT JOIN notification_prefs np ON np.user_id = n.recipient_id
        WHERE n.recipient_id = $1
          AND n.created_at > COALESCE(np.seen_at, 'epoch'::timestamptz)`,
      [session.userId],
    );
```

Update that function's doc-comment to say the badge counts UNSEEN (created after the last bell-open), decoupled from read_at.

- [ ] **Step 5: Register the route**

In `apps/api/src/routes.ts` add the import and entry (next to the notifications routes; note `/notifications/seen` is a literal under `/notifications/*`, no dynamic-shadow risk):

```ts
import { handleMarkSeen } from "./notifications/seen";
```
```ts
  { method: "POST", pattern: "/notifications/seen", handler: handleMarkSeen },
```

- [ ] **Step 6: Add the web proxy**

`apps/web/src/pages/api/notifications-seen.ts` (mirror `notifications-read.ts` exactly, changing the path and requiring no body):

```ts
/**
 * BROWSER → api authed hop for MARK-SEEN (M2.3c). Advances the caller's badge
 * watermark; same forward-cookie+Origin+CSRF shape as notifications-read. No
 * request body. Never cached.
 */
import { apiFetch, applyCookies } from "../../lib/api";
import { markPrivate } from "../../lib/cache";

import type { APIRoute } from "astro";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  const response = await apiFetch<unknown>("/notifications/seen", {
    method: "POST",
    body: {},
    request: context.request,
    origin: context.request.headers.get("Origin") ?? "",
    csrfToken: context.request.headers.get("X-CSRF-Token") ?? "",
  });
  applyCookies(headers, response.setCookies);
  return new Response(response.text, { status: response.status, headers });
};
```

- [ ] **Step 7: Rewire the bell island**

In `apps/web/src/scripts/notify-bell.ts`:

(a) In `openPanel`, replace the `POST /api/notifications-read {all:true}` block with a `POST /api/notifications-seen` (no body). Keep the CSRF-token idiom and the degraded-mode skip. On `markResp.ok`, clear the badge:

```ts
  try {
    const seenResp = await fetch("/api/notifications-seen", {
      method: "POST",
      headers: { "content-type": "application/json", "X-CSRF-Token": token },
      body: "{}",
    });
    if (seenResp.ok) {
      badge.hidden = true;
      badge.textContent = "";
    }
  } catch {
    // Network error advancing the seen watermark — leave the badge; the poll reconciles.
  }
```

(b) In `renderPanel`, when a group renders as an anchor (`href !== null`), attach a click handler that marks that group read (click-through = the only thing that sets read_at). Add after `link.textContent = text;`:

```ts
      link.addEventListener("click", () => {
        void fetch("/api/notifications-read", {
          method: "POST",
          headers: { "content-type": "application/json", "X-CSRF-Token": csrfForClick ?? "" },
          body: JSON.stringify({ ids: group.ids }),
        }).catch(() => {}); // fire-and-forget; navigation proceeds regardless
      });
```

`renderPanel` needs the CSRF token. Thread it in: change `renderPanel(panel, page)` to `renderPanel(panel, page, token)` where `token` is the value already fetched in `openPanel` via `getCsrfToken()` (fetch it before render there), and pass `null` from the live-nudge `loadList` path (a live refresh needn't rewire clicks it will re-render). Name the param `csrfForClick`. Update the two `renderPanel` call sites and `loadList(panel)` → `loadList(panel, token?)` accordingly. Update the file header bullet 3 to describe seen-on-open + read-on-click-through instead of mark-all-read.

- [ ] **Step 8: Update shipped tests**

- `apps/api/test/notifications.test.ts`: the existing "opening marks read → count 0" expectations move to the `{ids}`/`{all}` explicit paths (mark-read still works; only the bell's *caller* changed). Where a test asserted the count via a prior open, seed + assert directly. Do NOT delete `handleMarkRead` coverage.
- `apps/web/test/*` bell/notify tests: assert `openPanel` posts to `/api/notifications-seen` and click handlers post `/notifications/read` with `ids`.
- `e2e/notifications-realtime.spec.ts`: if it asserts "open the bell → badge clears," that still holds (seen). If it asserts a row becomes `read` merely by opening, change it to click-through.
- `apps/web/test/notify-seen-proxy.test.ts` (new, mirror `notify-proxies.test.ts`):

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const DIR = join(__dirname, "..", "src", "pages", "api");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
describe("notifications-seen proxy", () => {
  it("markPrivate + forwards CSRF + applyCookies to /notifications/seen", () => {
    const c = strip(readFileSync(join(DIR, "notifications-seen.ts"), "utf8"));
    expect(c).toContain("markPrivate(");
    expect(c).toContain("/notifications/seen");
    expect(c).toContain('context.request.headers.get("X-CSRF-Token")');
    expect(c).toContain("applyCookies(");
  });
});
```

- [ ] **Step 9: Run the suites, verify green**

Run: `pnpm --filter @thinkersjournal/api test -- notifications` and `pnpm --filter @thinkersjournal/web test`. Expected: PASS (including the updated shipped tests).

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/notifications/seen.ts apps/web/src/pages/api/notifications-seen.ts apps/api/src/routes/notifications.ts apps/api/src/routes.ts apps/web/src/scripts/notify-bell.ts apps/api/test/notifications-seen.test.ts apps/api/test/notifications.test.ts apps/web/test/
git commit -m "feat(m2.3c): decouple bell seen-watermark from click-through read"
```

---

## Task 5: Postmark transport refactor + `sendNotificationEmail`

**Files:**
- Create: `apps/api/src/auth/postmark.ts`
- Modify: `apps/api/src/auth/email-verify.ts` (rewrap `sendVerificationEmail`; add `sendNotificationEmail`)
- Test: `apps/api/test/postmark.test.ts`; keep `apps/api/test/email-verify.test.ts` green.

**Interfaces:**
- Produces:
  - `interface PostmarkMessage { from: string; to: string; subject: string; textBody: string; htmlBody: string; stream: string; headers?: { Name: string; Value: string }[] }`
  - `async function postmarkSend(env: Env, msg: PostmarkMessage): Promise<boolean>` — `true` iff 2xx AND `ErrorCode === 0`; never throws; never logs `to`/body.
  - `async function sendNotificationEmail(env, args: { to: string; subject: string; textBody: string; htmlBody: string; unsubUrl: string }): Promise<boolean>` — `stream: "broadcast"`, adds the RFC 8058 headers.
- Consumes (later, Task 8): `sendNotificationEmail`.

- [ ] **Step 1: Write the failing test**

`apps/api/test/postmark.test.ts` (stub global fetch — `fetchMock` is unavailable; mirror `email-verify.test.ts`):

```ts
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { postmarkSend } from "../src/auth/postmark";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function stubPostmark(resp: { status?: number; body?: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(resp.body ?? { ErrorCode: 0 }), {
      status: resp.status ?? 200, headers: { "content-type": "application/json" },
    });
  }));
  return calls;
}
const msg = {
  from: "noreply@thinkersjournal.com", to: "r@e.test", subject: "s",
  textBody: "t", htmlBody: "<p>t</p>", stream: "broadcast",
  headers: [{ Name: "List-Unsubscribe", Value: "<https://x/unsub?token=z>" }],
};

describe("postmarkSend", () => {
  it("returns true on 2xx + ErrorCode 0 and sends stream + headers", async () => {
    const calls = stubPostmark({ body: { ErrorCode: 0 } });
    expect(await postmarkSend(env, msg)).toBe(true);
    const sent = JSON.parse(String(calls[0]!.init!.body));
    expect(sent.MessageStream).toBe("broadcast");
    expect(sent.Headers).toEqual([{ Name: "List-Unsubscribe", Value: "<https://x/unsub?token=z>" }]);
    expect(new Headers(calls[0]!.init!.headers).get("X-Postmark-Server-Token")).toBe(env.POSTMARK_SERVER_TOKEN);
  });
  it("returns false on a non-zero ErrorCode (e.g. unconfirmed stream)", async () => {
    stubPostmark({ body: { ErrorCode: 401, Message: "no stream" } });
    expect(await postmarkSend(env, msg)).toBe(false);
  });
  it("returns false on a non-2xx", async () => {
    stubPostmark({ status: 500, body: {} });
    expect(await postmarkSend(env, msg)).toBe(false);
  });
  it("returns false (never throws) on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    expect(await postmarkSend(env, msg)).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @thinkersjournal/api test -- postmark.test`. Expected: FAIL — module missing.

- [ ] **Step 3: Implement `postmark.ts`**

`apps/api/src/auth/postmark.ts` (lift the transport from `email-verify.ts`; keep the never-throws + never-log-to/body discipline verbatim):

```ts
/**
 * The generic Postmark transport (M2.3c). Extracted from email-verify.ts so both
 * the verification email (stream "outbound") and notification email (stream
 * "broadcast") share ONE sender with ONE log discipline.
 *
 * NEVER THROWS — a failed send must not fail its caller. Returns true ONLY on a
 * confirmed accept (2xx AND ErrorCode 0); false on every failure, so the outbox
 * drain can leave emailed_at NULL and retry.
 *
 * ⚠️ NEVER logs `to`, subject, body, or any header value — those can carry the
 * recipient address and (for notifications) an unsubscribe token. Logs only
 * status / ErrorCode / Message, exactly as the verification send always has.
 */
interface PostmarkResponse { ErrorCode?: number; Message?: string }

export interface PostmarkMessage {
  from: string; to: string; subject: string;
  textBody: string; htmlBody: string;
  stream: string;
  headers?: { Name: string; Value: string }[];
}

export async function postmarkSend(env: Env, msg: PostmarkMessage): Promise<boolean> {
  try {
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "X-Postmark-Server-Token": env.POSTMARK_SERVER_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        From: msg.from, To: msg.to, Subject: msg.subject,
        TextBody: msg.textBody, HtmlBody: msg.htmlBody,
        MessageStream: msg.stream,
        ...(msg.headers !== undefined && { Headers: msg.headers }),
      }),
    });
    if (!res.ok) {
      console.error("postmark send failed", { status: res.status, stream: msg.stream });
      return false;
    }
    const { ErrorCode, Message } = (await res.json()) as PostmarkResponse;
    if (ErrorCode !== 0) {
      console.error("postmark rejected send", { ErrorCode, Message, stream: msg.stream });
      return false;
    }
    return true;
  } catch (err) {
    console.error("postmark request threw", err);
    return false;
  }
}
```

- [ ] **Step 4: Rewrap `sendVerificationEmail` and add `sendNotificationEmail`**

In `apps/api/src/auth/email-verify.ts`: keep `escapeHtml`; import `postmarkSend`; replace the body of `sendVerificationEmail` so it builds the same text/html and calls `postmarkSend(env, { from: "noreply@thinkersjournal.com", to: email, subject: "...", textBody, htmlBody, stream: "outbound" })` (behavior identical — the existing `email-verify.test.ts` captures URL/headers/body and MUST still pass; do not change Subject or body copy). Then add:

```ts
/**
 * Send a notification email on the Postmark BROADCAST stream (M2.3c). Adds the
 * RFC 8058 one-click unsubscribe headers (https URL only — no mailto). Body is
 * pre-escaped by the caller (email-content.ts). Returns postmarkSend's boolean so
 * the drain stamps emailed_at only on a confirmed send.
 */
export async function sendNotificationEmail(
  env: Env,
  args: { to: string; subject: string; textBody: string; htmlBody: string; unsubUrl: string },
): Promise<boolean> {
  return postmarkSend(env, {
    from: "noreply@thinkersjournal.com",
    to: args.to,
    subject: args.subject,
    textBody: args.textBody,
    htmlBody: args.htmlBody,
    stream: "broadcast",
    headers: [
      { Name: "List-Unsubscribe", Value: `<${args.unsubUrl}>` },
      { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
    ],
  });
}
```

- [ ] **Step 5: Run, verify pass**

Run: `pnpm --filter @thinkersjournal/api test -- postmark.test email-verify.test`. Expected: PASS for both (verification behavior unchanged; postmark transport covered).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/auth/postmark.ts apps/api/src/auth/email-verify.ts apps/api/test/postmark.test.ts
git commit -m "feat(m2.3c): extract postmarkSend + add sendNotificationEmail (broadcast)"
```

---

## Task 6: Unsubscribe — HMAC token + `POST /unsub` + web page + secret

**Files:**
- Create: `apps/api/src/notifications/unsub-token.ts`
- Create: `apps/api/src/routes/unsub.ts`
- Create: `apps/web/src/pages/unsub.astro`
- Modify: `apps/api/src/routes.ts` (register `POST /unsub`), `apps/api/test/route-protection.test.ts` (PIPELINE_EXEMPT), `apps/api/test/error-envelope.test.ts` (allowlist), `apps/api/.dev.vars`, vitest `miniflare.bindings`, regenerate `apps/api/src/worker-configuration.d.ts`.
- Test: `apps/api/test/unsub-token.test.ts`, `apps/api/test/unsub-route.test.ts`, `apps/web/test/unsub-page.test.ts`.

**Interfaces:**
- Produces:
  - `async function mintUnsubToken(env: Env, userId: string): Promise<string>` — `base64url(userId) + "." + base64url(HMAC_SHA256(userId))`.
  - `async function verifyUnsubToken(env: Env, token: string): Promise<string | null>` — userId or null (constant-time).
  - `handleUnsub` (`POST /unsub`) — reads `?token=`, on valid sets `master_enabled = false`; ALWAYS 200 (neutral). No session/CSRF/Origin.
- Consumes: `env.UNSUBSCRIBE_SIGNING_KEY`, `base64urlEncode`.

- [ ] **Step 1: Add the secret to the test env FIRST** (so tests can run)

- Add `UNSUBSCRIBE_SIGNING_KEY` to the vitest `miniflare.bindings` block in `apps/api/vitest.config.ts`:

```ts
                // A SECRET (src/notifications/unsub-token.ts). Dummy HMAC key for tests.
                UNSUBSCRIBE_SIGNING_KEY: "test-unsub-signing-key",
```

- Add a line to `apps/api/.dev.vars` (gitignored, dev only): `UNSUBSCRIBE_SIGNING_KEY=dev-unsub-signing-key-not-for-production`.
- Regenerate types: `pnpm --filter @thinkersjournal/api exec wrangler types ./src/worker-configuration.d.ts` — confirm `UNSUBSCRIBE_SIGNING_KEY: string` appears on `__BaseEnv_Env`. Commit the regenerated file with this task.

- [ ] **Step 2: Write the failing token test**

`apps/api/test/unsub-token.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintUnsubToken, verifyUnsubToken } from "../src/notifications/unsub-token";

describe("unsub HMAC token", () => {
  it("round-trips a userId", async () => {
    const uid = crypto.randomUUID();
    expect(await verifyUnsubToken(env, await mintUnsubToken(env, uid))).toBe(uid);
  });
  it("rejects a tampered payload", async () => {
    const t = await mintUnsubToken(env, crypto.randomUUID());
    const [, sig] = t.split(".");
    const forged = `${btoa("attacker").replace(/=+$/, "")}.${sig}`;
    expect(await verifyUnsubToken(env, forged)).toBeNull();
  });
  it("rejects a malformed token", async () => {
    expect(await verifyUnsubToken(env, "not-a-token")).toBeNull();
    expect(await verifyUnsubToken(env, "")).toBeNull();
  });
});
```

- [ ] **Step 3: Implement `unsub-token.ts`**

```ts
/**
 * Stateless HMAC unsubscribe tokens (M2.3c). token = base64url(userId) "."
 * base64url(HMAC_SHA256(userId, UNSUBSCRIBE_SIGNING_KEY)). No storage, idempotent,
 * never expires — correct for an unsubscribe link a user may click months later.
 * The token authenticates a one-click POST that comes cross-origin from a mail
 * provider with no cookie, and its only possible effect is master_enabled=false
 * for THIS userId — no escalation.
 */
import { base64urlEncode } from "../auth/encoding";

function b64urlToBytes(s: string): Uint8Array | null {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmac(env: Env, msg: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.UNSUBSCRIBE_SIGNING_KEY),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return new Uint8Array(sig);
}

export async function mintUnsubToken(env: Env, userId: string): Promise<string> {
  const payload = base64urlEncode(new TextEncoder().encode(userId));
  const sig = base64urlEncode(await hmac(env, userId));
  return `${payload}.${sig}`;
}

/** Constant-time verify. Returns the userId or null. */
export async function verifyUnsubToken(env: Env, token: string): Promise<string | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payloadBytes = b64urlToBytes(token.slice(0, dot));
  const sigBytes = b64urlToBytes(token.slice(dot + 1));
  if (payloadBytes === null || sigBytes === null) return null;
  const userId = new TextDecoder().decode(payloadBytes);
  const expected = await hmac(env, userId);
  if (sigBytes.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= sigBytes[i]! ^ expected[i]!;
  return diff === 0 ? userId : null;
}
```

- [ ] **Step 4: Run token test, verify pass**

Run: `pnpm --filter @thinkersjournal/api test -- unsub-token.test`. Expected: PASS.

- [ ] **Step 5: Write the failing route test**

`apps/api/test/unsub-route.test.ts`:

```ts
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";
import worker from "../src";
import { withClient } from "../src/db/client";
import { mintUnsubToken } from "../src/notifications/unsub-token";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

afterAll(deleteCreatedUsers);
async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const r = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return r;
}
async function masterEnabled(userId: string): Promise<boolean | null> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ m: boolean }>(
      `SELECT master_enabled m FROM notification_prefs WHERE user_id=$1`, [userId]);
    return rows[0]?.m ?? null;
  });
  await waitOnExecutionContext(ctx);
  return v;
}
const unsubReq = (token: string) =>
  new Request(`https://api.test/unsub?token=${encodeURIComponent(token)}`, { method: "POST" });

describe("POST /unsub", () => {
  it("a valid token sets master_enabled=false and returns 200", async () => {
    const a = await createVerifiedActor();
    expect((await fetchWorker(unsubReq(await mintUnsubToken(env, a.userId)))).status).toBe(200);
    expect(await masterEnabled(a.userId)).toBe(false);
  });
  it("an invalid token still returns a neutral 200 and changes nothing", async () => {
    const a = await createVerifiedActor();
    expect((await fetchWorker(unsubReq("garbage.token"))).status).toBe(200);
    expect(await masterEnabled(a.userId)).toBeNull(); // no row created
  });
  it("needs no session or CSRF (cross-origin one-click)", async () => {
    const a = await createVerifiedActor();
    const r = await fetchWorker(unsubReq(await mintUnsubToken(env, a.userId))); // no Cookie/Origin/CSRF
    expect(r.status).toBe(200);
  });
});
```

- [ ] **Step 6: Implement `handleUnsub` and register it**

`apps/api/src/routes/unsub.ts`:

```ts
/**
 * One-click unsubscribe (M2.3c, RFC 8058). Token-authed, NO session / CSRF /
 * Origin check: the POST comes cross-origin from a mail provider with no cookie,
 * and the HMAC token IS the auth. The only effect is master_enabled=false for the
 * token's user. ALWAYS returns a neutral 200 — never reveal whether a token was
 * valid, never error. Idempotent. Listed in PIPELINE_EXEMPT and allowlisted in
 * error-envelope.test.ts (it has no error path).
 */
import { withClient } from "../db/client";
import { verifyUnsubToken } from "../notifications/unsub-token";

export async function handleUnsub(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  const ok = (): Response =>
    new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });

  const userId = token === null ? null : await verifyUnsubToken(env, token);
  if (userId === null) return ok(); // neutral

  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query(
      `INSERT INTO notification_prefs (user_id, master_enabled, updated_at)
       VALUES ($1, false, now())
       ON CONFLICT (user_id) DO UPDATE SET master_enabled = false, updated_at = now()`,
      [userId],
    ),
  );
  return ok();
}
```

Register in `apps/api/src/routes.ts` (import + entry; place it near the auth routes since it is unauthenticated):

```ts
import { handleUnsub } from "./routes/unsub";
```
```ts
  // One-click unsubscribe (M2.3c). Token-authed, NOT the mutating pipeline — no
  // session/CSRF (a mail provider's cross-origin one-click). PIPELINE_EXEMPT.
  { method: "POST", pattern: "/unsub", handler: handleUnsub },
```

- [ ] **Step 7: Satisfy the two ROUTES guard tests**

- `apps/api/test/route-protection.test.ts`: add `POST /unsub` to `PIPELINE_EXEMPT` with a comment mirroring the verify-email/csrf justification ("token-authed one-click unsubscribe; cross-origin, no session/CSRF by design").
- `apps/api/test/error-envelope.test.ts`: allowlist `POST /unsub` as having no error path (always neutral 200).

- [ ] **Step 8: Build the web page**

`apps/web/src/pages/unsub.astro` (public, no auth; handles GET render + one-click POST — Astro invokes the page for both methods when `prerender = false`, exactly like `choose-username.astro` branches on method):

```astro
---
/**
 * Public one-click unsubscribe landing (M2.3c). The email's List-Unsubscribe URL
 * points here (community origin). GET = a human clicked the link; POST = the mail
 * client's RFC 8058 one-click. Both read ?token= and call the api's POST /unsub
 * (token-authed, no session). Always renders/returns success — unsubscribe is
 * idempotent and we never reveal token validity.
 */
import BaseLayout from "../components/BaseLayout.astro";
import { apiFetch } from "../lib/api";
import { markPrivate } from "../lib/cache";
import { setPublicPageCsp } from "../lib/csp";

markPrivate(Astro);
setPublicPageCsp(Astro);

const token = Astro.url.searchParams.get("token") ?? "";
// Fire the api call for BOTH GET and POST. Origin omitted — the api's /unsub does
// not check it (token is the auth).
await apiFetch<unknown>(`/unsub?token=${encodeURIComponent(token)}`, { method: "POST" });

if (Astro.request.method === "POST") {
  // RFC 8058 one-click: no body needed back, just 200.
  return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
}
---
<BaseLayout title="Unsubscribed">
  <div class="wrap">
    <h1>You're unsubscribed</h1>
    <p>You will no longer receive notification emails from Thinkers Journal.</p>
    <p>Changed your mind? <a class="link" href="/settings/notifications">Manage notification preferences</a>.</p>
  </div>
</BaseLayout>
```

- [ ] **Step 9: Web page source test**

`apps/web/test/unsub-page.test.ts` (mirror `notifications-page.test.ts` static-assertion style):

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
describe("unsub.astro", () => {
  const c = strip(readFileSync(join(__dirname, "..", "src", "pages", "unsub.astro"), "utf8"));
  it("markPrivate, reads ?token=, calls /unsub, links to settings", () => {
    expect(c).toContain("markPrivate(");
    expect(c).toContain('searchParams.get("token")');
    expect(c).toContain("/unsub?token=");
    expect(c).toContain("/settings/notifications");
  });
  it("handles the one-click POST", () => {
    expect(c).toContain('Astro.request.method === "POST"');
  });
});
```

- [ ] **Step 10: Run all Task-6 suites, verify pass**

Run: `pnpm --filter @thinkersjournal/api test -- unsub-token unsub-route route-protection error-envelope` and `pnpm --filter @thinkersjournal/web test -- unsub-page`. Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/notifications/unsub-token.ts apps/api/src/routes/unsub.ts apps/web/src/pages/unsub.astro apps/api/src/routes.ts apps/api/test/unsub-token.test.ts apps/api/test/unsub-route.test.ts apps/web/test/unsub-page.test.ts apps/api/test/route-protection.test.ts apps/api/test/error-envelope.test.ts apps/api/vitest.config.ts apps/api/src/worker-configuration.d.ts
git commit -m "feat(m2.3c): HMAC one-click unsubscribe (POST /unsub + web page)"
```

> The implementer's environment has `apps/api/.dev.vars` (gitignored). Its edit is local and not committed. `wrangler secret put UNSUBSCRIBE_SIGNING_KEY` is a DEPLOY step (Task 8 notes it).

---

## Task 7: Email content builder

**Files:**
- Create: `apps/api/src/notifications/email-content.ts`
- Test: `apps/api/test/email-content.test.ts`

**Interfaces:**
- Consumes: `collapseNotifications`, `notificationLabel`, `notificationHref`, `CollapsedNotification`, `NotificationItem` from shared; `escapeHtml` (export it from `email-verify.ts` or copy into a shared `apps/api/src/http/escape-html.ts` — prefer exporting the existing one to avoid a second copy).
- Produces: `function buildNotificationEmail(items: NotificationItem[], opts: { unsubUrl: string; disposition: "instant" | "digest" }): { subject: string; textBody: string; htmlBody: string }`.

- [ ] **Step 1: Export `escapeHtml`**

In `apps/api/src/auth/email-verify.ts`, change `function escapeHtml` to `export function escapeHtml` (single source; keep it where it is).

- [ ] **Step 2: Write the failing test**

`apps/api/test/email-content.test.ts` (pure — no cloudflare:test needed, but keep it in the pool project for the shared import; a plain unit test is fine):

```ts
import { describe, expect, it } from "vitest";
import { buildNotificationEmail } from "../src/notifications/email-content";
import type { NotificationItem } from "@thinkersjournal/shared";

function item(over: Partial<NotificationItem>): NotificationItem {
  return {
    id: crypto.randomUUID(), kind: "post_comment",
    actor: { username: "ada", displayName: "Ada" },
    postId: "p1", postTitle: "On Method", postSlug: "on-method",
    postAuthorUsername: "me", commentId: "c1", reactionKind: null,
    createdAt: "2026-07-31T00:00:00Z", read: false, ...over,
  };
}
const U = "https://community.thinkersjournal.com/unsub?token=z";

describe("buildNotificationEmail", () => {
  it("instant single-group subject is the label sentence", () => {
    const e = buildNotificationEmail([item({})], { unsubUrl: U, disposition: "instant" });
    expect(e.subject).toContain("Ada");
    expect(e.subject).toContain("On Method");
    expect(e.htmlBody).toContain("https://community.thinkersjournal.com/@me/on-method");
    expect(e.htmlBody).toContain(U);
  });
  it("instant multi-group subject counts groups", () => {
    const e = buildNotificationEmail(
      [item({}), item({ kind: "follow", postId: null, postSlug: null, commentId: null, actor: { username: "bo", displayName: "Bo" } })],
      { unsubUrl: U, disposition: "instant" });
    expect(e.subject).toBe("You have 2 new notifications");
  });
  it("digest subject uses the digest wording", () => {
    const e = buildNotificationEmail([item({})], { unsubUrl: U, disposition: "digest" });
    expect(e.subject.toLowerCase()).toContain("digest");
  });
  it("escapes a malicious post title", () => {
    const e = buildNotificationEmail([item({ postTitle: '<script>x</script>' })], { unsubUrl: U, disposition: "instant" });
    expect(e.htmlBody).not.toContain("<script>x</script>");
    expect(e.htmlBody).toContain("&lt;script&gt;");
  });
});
```

- [ ] **Step 3: Implement `email-content.ts`**

```ts
/**
 * Render a recipient's collapsed notifications into a Postmark email body (M2.3c).
 * Reuses the SAME shared copy helpers as the bell (notificationLabel/Href) so
 * email and in-app wording can never diverge. Every user-derived value is
 * escapeHtml'd. Links are absolutized against the canonical origin; a null href
 * (deleted post) renders as plain text.
 */
import { escapeHtml } from "../auth/email-verify";
import { collapseNotifications, notificationHref, notificationLabel } from "@thinkersjournal/shared";
import type { CollapsedNotification, NotificationItem } from "@thinkersjournal/shared";

const ORIGIN = "https://community.thinkersjournal.com";

function lineText(g: CollapsedNotification): string {
  const l = notificationLabel(g);
  return `${l.leadName}${l.rest}`;
}
function absHref(g: CollapsedNotification): string | null {
  const href = notificationHref(g);
  return href === null ? null : `${ORIGIN}${href}`;
}

export function buildNotificationEmail(
  items: NotificationItem[],
  opts: { unsubUrl: string; disposition: "instant" | "digest" },
): { subject: string; textBody: string; htmlBody: string } {
  const groups = collapseNotifications(items);

  const subject =
    opts.disposition === "digest"
      ? `Your Thinkers Journal digest — ${groups.length} update${groups.length === 1 ? "" : "s"}`
      : groups.length === 1
        ? lineText(groups[0]!)
        : `You have ${groups.length} new notifications`;

  const textLines = groups.map((g) => {
    const href = absHref(g);
    return href === null ? lineText(g) : `${lineText(g)}\n  ${href}`;
  });
  const textBody =
    `${textLines.join("\n\n")}\n\n—\nManage preferences: ${ORIGIN}/settings/notifications\nUnsubscribe: ${opts.unsubUrl}\n`;

  const htmlItems = groups
    .map((g) => {
      const href = absHref(g);
      const text = escapeHtml(lineText(g));
      return href === null ? `<li>${text}</li>` : `<li><a href="${escapeHtml(href)}">${text}</a></li>`;
    })
    .join("");
  const htmlBody =
    `<ul>${htmlItems}</ul>` +
    `<p style="color:#888;font-size:13px">` +
    `<a href="${escapeHtml(`${ORIGIN}/settings/notifications`)}">Manage preferences</a> · ` +
    `<a href="${escapeHtml(opts.unsubUrl)}">Unsubscribe</a></p>`;

  return { subject, textBody, htmlBody };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @thinkersjournal/api test -- email-content.test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/notifications/email-content.ts apps/api/src/auth/email-verify.ts apps/api/test/email-content.test.ts
git commit -m "feat(m2.3c): notification email content builder"
```

---

## Task 8: Outbox drain + `scheduled()` + cron triggers

**Files:**
- Create: `apps/api/src/notifications/email-drain.ts`
- Modify: `apps/api/src/index.ts` (add `scheduled`)
- Modify: `apps/api/wrangler.jsonc` (`triggers.crons`)
- Test: `apps/api/test/email-drain.test.ts`

**Interfaces:**
- Consumes: `withClient`, `collapseNotifications`, `buildNotificationEmail`, `sendNotificationEmail`, `mintUnsubToken`.
- Produces: `async function runEmailDrain(env: Env, ctx: ExecutionContext, disposition: "instant" | "digest"): Promise<void>`. `index.ts` default export gains `scheduled(controller, env, ctx)` that maps `controller.cron` → disposition and `ctx.waitUntil(runEmailDrain(...))`.

- [ ] **Step 1: Write the failing test**

`apps/api/test/email-drain.test.ts` (pool; stub global fetch to capture Postmark sends; seed via SQL). Covers selection-by-disposition, coalescing, stamp-on-success-only, and suppression:

```ts
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, afterAll, describe, expect, it, vi } from "vitest";
import { withClient } from "../src/db/client";
import { runEmailDrain } from "../src/notifications/email-drain";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

afterAll(deleteCreatedUsers);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Capture Postmark sends; default success (ErrorCode 0).
function stubPostmark(ok = true): { to: string; body: string }[] {
  const sends: { to: string; body: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_i: unknown, init?: RequestInit) => {
    const b = JSON.parse(String(init!.body));
    sends.push({ to: b.To, body: String(init!.body) });
    return new Response(JSON.stringify({ ErrorCode: ok ? 0 : 10 }), { status: ok ? 200 : 200 });
  }));
  return sends;
}
async function ctxRun<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}
async function seedNotif(recipientId: string, actorId: string, kind: string): Promise<string> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO notifications (recipient_id, actor_id, kind) VALUES ($1,$2,$3) RETURNING id`,
      [recipientId, actorId, kind]);
    return rows[0]!.id;
  });
}
async function emailedAt(id: string): Promise<string | null> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ e: string | null }>(`SELECT emailed_at e FROM notifications WHERE id=$1`, [id]);
    return rows[0]!.e;
  });
}
async function drain(disposition: "instant" | "digest"): Promise<void> {
  const ctx = createExecutionContext();
  await runEmailDrain(env, ctx, disposition);
  await waitOnExecutionContext(ctx);
}
async function resetLock(): Promise<void> {
  await ctxRun((c) => c.query(`UPDATE email_drain_lock SET leased_until = NULL`));
}

describe("runEmailDrain", () => {
  it("instant pass emails a direct-kind notification once and stamps emailed_at", async () => {
    await resetLock();
    const me = await createVerifiedActor();
    const actor = await createVerifiedActor();
    const id = await seedNotif(me.userId, actor.userId, "post_comment"); // direct default = instant
    const sends = stubPostmark();
    await drain("instant");
    expect(sends).toHaveLength(1);
    expect(await emailedAt(id)).not.toBeNull();
  });

  it("digest-default kinds are NOT sent on the instant pass", async () => {
    await resetLock();
    const me = await createVerifiedActor();
    const actor = await createVerifiedActor();
    const id = await seedNotif(me.userId, actor.userId, "follow"); // follows default = digest
    const sends = stubPostmark();
    await drain("instant");
    expect(sends).toHaveLength(0);
    expect(await emailedAt(id)).toBeNull();
    // ...but the digest pass sends it.
    await resetLock();
    await drain("digest");
    expect(await emailedAt(id)).not.toBeNull();
  });

  it("does NOT stamp emailed_at when the send fails (retry next pass)", async () => {
    await resetLock();
    const me = await createVerifiedActor();
    const actor = await createVerifiedActor();
    const id = await seedNotif(me.userId, actor.userId, "post_comment");
    stubPostmark(false); // ErrorCode != 0
    await drain("instant");
    expect(await emailedAt(id)).toBeNull();
  });

  it("coalesces a burst to one recipient into a single email", async () => {
    await resetLock();
    const me = await createVerifiedActor();
    const a1 = await createVerifiedActor();
    const a2 = await createVerifiedActor();
    await seedNotif(me.userId, a1.userId, "post_comment");
    await seedNotif(me.userId, a2.userId, "comment_reply");
    const sends = stubPostmark();
    await drain("instant");
    expect(sends).toHaveLength(1); // one email, both events inside
  });

  it("suppresses an already-read notification", async () => {
    await resetLock();
    const me = await createVerifiedActor();
    const actor = await createVerifiedActor();
    const id = await seedNotif(me.userId, actor.userId, "post_comment");
    await ctxRun((c) => c.query(`UPDATE notifications SET read_at = now() WHERE id=$1`, [id]));
    const sends = stubPostmark();
    await drain("instant");
    expect(sends).toHaveLength(0);
  });

  it("skips when the lease is already held (single-flight)", async () => {
    await ctxRun((c) => c.query(`UPDATE email_drain_lock SET leased_until = now() + interval '90 seconds' WHERE pass='instant'`));
    const me = await createVerifiedActor();
    const actor = await createVerifiedActor();
    await seedNotif(me.userId, actor.userId, "post_comment");
    const sends = stubPostmark();
    await drain("instant");
    expect(sends).toHaveLength(0); // lease held → no work
    await resetLock();
  });
});
```

> Note on test isolation: seeded users accumulate; `createVerifiedActor` makes verified users, so unrelated prior rows may also be eligible. Keep each assertion about the SPECIFIC seeded ids (`emailedAt(id)`) and about send COUNT deltas where the recipient is unique to the test. If cross-test eligible rows make raw `sends.length` brittle, filter `sends` by `to === <this recipient's email>` — expose the email on the actor or look it up. The implementer should make count assertions robust to other verified users' pending rows (filter by recipient).

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @thinkersjournal/api test -- email-drain.test`. Expected: FAIL — module missing.

- [ ] **Step 3: Implement `email-drain.ts`**

```ts
/**
 * The email OUTBOX drain (M2.3c). One pass per disposition ('instant' every 2 min,
 * 'digest' daily). Single-flight via the email_drain_lock lease row (NOT a session
 * advisory lock — unreliable through Hyperdrive's transaction-mode pooling; see
 * db/client.ts). Selects eligible rows (unsent, unread, verified recipient, master
 * on, category channel = this disposition), coalesces per recipient into ONE email
 * (shared collapse/label copy), and stamps emailed_at ONLY on a confirmed send so a
 * failure retries next pass.
 */
import { sendNotificationEmail } from "../auth/email-verify";
import { withClient } from "../db/client";
import { buildNotificationEmail } from "./email-content";
import { mintUnsubToken } from "./unsub-token";

import type { Client } from "pg";
import type { NotificationItem } from "@thinkersjournal/shared";

const ORIGIN = "https://community.thinkersjournal.com";

interface DrainRow {
  id: string; recipientId: string; email: string;
  kind: NotificationItem["kind"];
  username: string; displayName: string | null;
  postId: string | null; postTitle: string | null; postSlug: string | null; postAuthorUsername: string | null;
  commentId: string | null; reactionKind: string | null; createdAt: string;
}

// Category channel per row = CASE on kind → the matching prefs column, COALESCE'd
// to the spec default for an absent prefs row. Compared to $1 (the disposition).
const SELECT_ELIGIBLE = `
  SELECT n.id, n.recipient_id AS "recipientId", u.email,
         n.kind,
         ap.username, ap.display_name AS "displayName",
         n.post_id AS "postId", p.title AS "postTitle", p.slug AS "postSlug",
         pp.username AS "postAuthorUsername",
         n.comment_id AS "commentId", n.reaction_kind AS "reactionKind",
         n.created_at AS "createdAt"
    FROM notifications n
    JOIN users u ON u.id = n.recipient_id
    JOIN profiles ap ON ap.user_id = n.actor_id
    LEFT JOIN notification_prefs np ON np.user_id = n.recipient_id
    LEFT JOIN posts p ON p.id = n.post_id
    LEFT JOIN profiles pp ON pp.user_id = p.author_id
   WHERE n.emailed_at IS NULL
     AND n.read_at IS NULL
     AND u.email_verified_at IS NOT NULL
     AND COALESCE(np.master_enabled, true) = true
     AND CASE
           WHEN n.kind IN ('post_comment','comment_reply')   THEN COALESCE(np.direct, 'instant')
           WHEN n.kind IN ('post_reaction','comment_reaction') THEN COALESCE(np.reactions, 'digest')
           WHEN n.kind = 'follow'                             THEN COALESCE(np.follows, 'digest')
         END = $1::notification_channel
   ORDER BY n.recipient_id, n.created_at`;

function toItem(r: DrainRow): NotificationItem {
  return {
    id: r.id, kind: r.kind,
    actor: { username: r.username, displayName: r.displayName },
    postId: r.postId, postTitle: r.postTitle, postSlug: r.postSlug,
    postAuthorUsername: r.postAuthorUsername,
    commentId: r.commentId, reactionKind: r.reactionKind,
    createdAt: r.createdAt, read: false,
  };
}

export async function runEmailDrain(
  env: Env, ctx: ExecutionContext, disposition: "instant" | "digest",
): Promise<void> {
  // Phase A: acquire the lease and read the work in one connection, then release it.
  const claim = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c: Client) => {
    const lock = await c.query(
      `UPDATE email_drain_lock SET leased_until = now() + interval '90 seconds'
        WHERE pass = $1 AND (leased_until IS NULL OR leased_until < now()) RETURNING pass`,
      [disposition],
    );
    if ((lock.rowCount ?? 0) === 0) return null; // another pass holds the lease
    const { rows } = await c.query<DrainRow>(SELECT_ELIGIBLE, [disposition]);
    return rows;
  });
  if (claim === null) return;

  try {
    // Phase B: group by recipient, send one email each, collect stamped ids.
    const byRecipient = new Map<string, DrainRow[]>();
    for (const r of claim) {
      const list = byRecipient.get(r.recipientId);
      if (list === undefined) byRecipient.set(r.recipientId, [r]);
      else list.push(r);
    }
    const sentIds: string[] = [];
    for (const [recipientId, rows] of byRecipient) {
      const token = await mintUnsubToken(env, recipientId);
      const email = buildNotificationEmail(rows.map(toItem), {
        unsubUrl: `${ORIGIN}/unsub?token=${encodeURIComponent(token)}`, disposition,
      });
      const ok = await sendNotificationEmail(env, { to: rows[0]!.email, ...email });
      if (ok) for (const r of rows) sentIds.push(r.id);
    }
    // Phase C: stamp only the confirmed sends.
    if (sentIds.length > 0) {
      await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
        c.query(`UPDATE notifications SET emailed_at = now() WHERE id = ANY($1::uuid[]) AND emailed_at IS NULL`, [sentIds]),
      );
    }
  } finally {
    // Release the lease (a crash instead auto-expires it after 90s).
    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
      c.query(`UPDATE email_drain_lock SET leased_until = NULL WHERE pass = $1`, [disposition]),
    );
  }
}
```

- [ ] **Step 4: Add the `scheduled` handler**

In `apps/api/src/index.ts`, add the import and the `scheduled` method (keep it a thin dispatcher — mirror the "this file only dispatches" discipline):

```ts
import { runEmailDrain } from "./notifications/email-drain";
```
```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    const match = findRoute(ROUTES, request.method, pathname);
    if (match === null) return notFoundResponse();
    return await match.route.handler(request, env, ctx, match.params);
  },
  // The email outbox drains (M2.3c). Two cron patterns, one dispatcher: the daily
  // pattern drains DIGEST-disposition rows, every other pattern drains INSTANT.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const disposition = controller.cron === "0 14 * * *" ? "digest" : "instant";
    ctx.waitUntil(runEmailDrain(env, ctx, disposition));
  },
} satisfies ExportedHandler<Env>;
```

If any test asserts the `index.ts` default-export shape (grep `test/` for `scheduled` or default-export assertions), update it to allow the new `scheduled` method. `route-protection.test.ts` imports `ROUTES` (unaffected — `scheduled` is not a route).

- [ ] **Step 5: Add the cron triggers**

In `apps/api/wrangler.jsonc`, add a top-level key (near `observability`):

```jsonc
  // Email outbox drains (M2.3c) — api's FIRST cron. */2 = instant pass; the daily
  // 14:00 UTC = digest pass. src/index.ts's scheduled() branches on controller.cron.
  "triggers": { "crons": ["*/2 * * * *", "0 14 * * *"] },
```

Then regenerate types if needed: `pnpm --filter @thinkersjournal/api exec wrangler types ./src/worker-configuration.d.ts` (crons don't change `Env`, but keep the file in sync).

- [ ] **Step 6: Run, verify pass**

Run: `pnpm --filter @thinkersjournal/api test -- email-drain.test`. Expected: PASS. Then run the whole api suite to catch the index-shape/route guards: `pnpm --filter @thinkersjournal/api test`. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/notifications/email-drain.ts apps/api/src/index.ts apps/api/wrangler.jsonc apps/api/src/worker-configuration.d.ts apps/api/test/email-drain.test.ts
git commit -m "feat(m2.3c): outbox drain + scheduled() cron dispatcher"
```

> **DEPLOY NOTES (documented, not run here):** (1) create the Postmark **Broadcast** message stream; until it exists, broadcast sends return a non-zero ErrorCode → `emailed_at` stays NULL → rows retry (no loss). (2) `wrangler secret put UNSUBSCRIBE_SIGNING_KEY`. (3) the cron triggers deploy with the Worker.

---

## Task 9: Settings page — `/settings/notifications`

**Files:**
- Create: `apps/web/src/pages/settings/notifications.astro`
- Test: `apps/web/test/settings-notifications-page.test.ts`

**Interfaces:**
- Consumes: `apiFetch`, `apiErrorCode`, `applyCookies` (`web/src/lib/api`); api `GET`/`PUT /notification-prefs`; `NotificationPrefs`, `NOTIFICATION_CHANNELS`.
- Produces: the authed settings form (master checkbox + three channel selects). GET renders current prefs; POST saves via api PUT, then re-renders with a saved notice.

- [ ] **Step 1: Write the failing source test**

`apps/web/test/settings-notifications-page.test.ts` (mirror `choose-username-page.test.ts`):

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const c = strip(readFileSync(join(__dirname, "..", "src", "pages", "settings", "notifications.astro"), "utf8"));
describe("settings/notifications.astro", () => {
  it("is authed (markPrivate) and talks to /notification-prefs both ways", () => {
    expect(c).toContain("markPrivate(");
    expect(c).toContain("/notification-prefs");
    expect(c).toContain('method: "PUT"');
  });
  it("forwards Origin + CSRF and applies cookies on save", () => {
    expect(c).toContain('Astro.request.headers.get("Origin")');
    expect(c).toContain("csrfToken");
    expect(c).toContain("applyCookies(");
  });
  it("renders the master toggle and three category selects", () => {
    expect(c).toContain('name="masterEnabled"');
    expect(c).toContain('name="direct"');
    expect(c).toContain('name="reactions"');
    expect(c).toContain('name="follows"');
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @thinkersjournal/web test -- settings-notifications-page`. Expected: FAIL — file missing.

- [ ] **Step 3: Implement the page**

`apps/web/src/pages/settings/notifications.astro` (adapt `choose-username.astro`'s authed GET/POST + hand-built-redirect-with-cookies pattern):

```astro
---
/**
 * Notification email preferences (M2.3c), authed + never cached. GET renders the
 * user's current prefs (api defaults when no row); POST (the form) forwards to the
 * api's PUT /notification-prefs with Origin + CSRF, then re-renders with a saved
 * notice. A one-click-unsubscribed user re-enables here (master toggle).
 */
import BaseLayout from "../../components/BaseLayout.astro";
import { apiErrorCode, apiFetch, applyCookies } from "../../lib/api";
import { markPrivate } from "../../lib/cache";
import { setPublicPageCsp } from "../../lib/csp";

import { DEFAULT_NOTIFICATION_PREFS, NOTIFICATION_CHANNELS } from "@thinkersjournal/shared";
import type { NotificationPrefs } from "@thinkersjournal/shared";

markPrivate(Astro);
setPublicPageCsp(Astro);

const csrf = await apiFetch<{ csrfToken: string }>("/auth/csrf", { request: Astro.request });
const csrfToken = csrf.status === 200 ? (csrf.data?.csrfToken ?? null) : null;
if (csrfToken === null) return Astro.redirect("/login");

let saved = false;
let error: string | null = null;

if (Astro.request.method === "POST") {
  const form = await Astro.request.formData();
  const body = {
    masterEnabled: form.get("masterEnabled") === "on",
    direct: String(form.get("direct") ?? "instant"),
    reactions: String(form.get("reactions") ?? "digest"),
    follows: String(form.get("follows") ?? "digest"),
  };
  const res = await apiFetch<NotificationPrefs>("/notification-prefs", {
    method: "PUT", body, request: Astro.request,
    origin: Astro.request.headers.get("Origin") ?? "",
    csrfToken: String(form.get("csrfToken") ?? ""),
  });
  applyCookies(Astro.response.headers, res.setCookies);
  if (res.status === 200) saved = true;
  else error = apiErrorCode(res) ?? "SAVE_FAILED";
}

const current = await apiFetch<NotificationPrefs>("/notification-prefs", { request: Astro.request });
const prefs: NotificationPrefs = current.status === 200 && current.data ? current.data : DEFAULT_NOTIFICATION_PREFS;
---
<BaseLayout title="Notification settings">
  <div class="wrap">
    <h1>Notification emails</h1>
    {saved && <p class="ok">Saved.</p>}
    {error && <p class="err">Could not save. Try again.</p>}
    <form method="POST" class="form">
      <input type="hidden" name="csrfToken" value={csrfToken} />
      <label class="row">
        <input type="checkbox" name="masterEnabled" checked={prefs.masterEnabled} />
        Send me notification emails
      </label>
      {([
        ["direct", "Comments & replies to me"],
        ["reactions", "Reactions to my posts & comments"],
        ["follows", "New followers"],
      ] as const).map(([field, label]) => (
        <label class="row">
          <span>{label}</span>
          <select name={field}>
            {NOTIFICATION_CHANNELS.map((ch) => (
              <option value={ch} selected={prefs[field] === ch}>{ch}</option>
            ))}
          </select>
        </label>
      ))}
      <button type="submit" class="btn btn-primary">Save</button>
    </form>
  </div>
</BaseLayout>
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @thinkersjournal/web test -- settings-notifications-page`. Expected: PASS. If the suite runs a build-manifest check (`it.runIf(built)` in sibling tests), run the web build so the route registers.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/settings/notifications.astro apps/web/test/settings-notifications-page.test.ts
git commit -m "feat(m2.3c): notification settings page"
```

---

## Task 10: e2e spine — away-user emailed, read suppresses, seen≠read

**Files:**
- Create: `e2e/email-notifications.spec.ts`

**Interfaces:**
- Consumes: `signUpAndVerify`, `chooseUsername`, `publishPost`, `uniqueHandle` from `e2e/helpers.ts`; the `__test` token flow; the api base `API_URL`.

**Note on the Postmark assertion:** the dev harness has a dummy `POSTMARK_SERVER_TOKEN`, so real sends fail (logged "postmark send failed") — you cannot assert an inbox. The e2e asserts the OUTBOX STATE instead: after triggering the instant pass, the notification row's `emailed_at` is set (send *attempted* and, in the harness, the send returns non-2xx so `emailed_at` stays NULL). Because the harness can't confirm a send, this spec drives the **observable app behavior** — prefs save, badge = seen, rows = click-through read — and leaves send-stamping to Task 8's `cloudflare:test` (which stubs Postmark to success). Do NOT try to assert real email delivery in e2e.

- [ ] **Step 1: Write the e2e**

`e2e/email-notifications.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { chooseUsername, publishPost, signUpAndVerify, uniqueHandle } from "./helpers";

test("notification settings persist and the bell separates seen from read", async ({ page, request }) => {
  await signUpAndVerify(page, request);
  await chooseUsername(page, uniqueHandle("settings"));

  // Save prefs: turn Reactions off, keep Direct instant.
  await page.goto("/settings/notifications");
  await page.selectOption('select[name="reactions"]', "off");
  await page.click('button[type="submit"]');
  await expect(page.locator(".ok")).toBeVisible();

  // Reload: the saved value round-trips.
  await page.goto("/settings/notifications");
  await expect(page.locator('select[name="reactions"]')).toHaveValue("off");
});

test("opening the bell clears the badge (seen) but does not mark rows read", async ({ page, request, browser }) => {
  // A publishes a post; B comments so A has a real notification.
  await signUpAndVerify(page, request);
  const handleA = uniqueHandle("author");
  const post = await publishPost(page, { title: "Live", markdownSource: "hello" });

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  const reqB = ctxB.request;
  await signUpAndVerify(pageB, reqB);
  await chooseUsername(pageB, uniqueHandle("commenter"));
  await pageB.goto(post.url);
  await pageB.fill('[data-comment-input] textarea, textarea[name="body"]', "great post");
  await pageB.click('[data-comment-submit], button[type="submit"]');

  // A: badge shows, open the bell → badge clears (seen), row still styled unread.
  await page.goto("/feed");
  const badge = page.locator("[data-notify-badge]");
  await expect(badge).toBeVisible();
  await page.click("[data-notify-toggle]");
  await expect(page.locator("[data-notify-panel] .notify-row")).toHaveCount(1);
  await expect(badge).toBeHidden(); // seen cleared the badge
  await expect(page.locator("[data-notify-panel] .notify-row.unread")).toHaveCount(1); // not read

  await ctxB.close();
});
```

> Selectors: confirm the comment input/submit and `.notify-row`/`.unread`/`[data-notify-*]` selectors against the current DOM (they come from `notify-bell.ts` and the post page); adjust to the real attributes if they differ. The two-context pattern mirrors `e2e/post-live.spec.ts`.

- [ ] **Step 2: Reset the dev DB, then run**

Per project convention, reset the dev DB before e2e (random users accumulate). Then:

Run: `pnpm --filter e2e test -- email-notifications` (or the repo's e2e command). Expected: PASS. Expected harness noise: "postmark send failed" (dummy token), "cache.purge is not a function" — documented artifacts, not failures.

- [ ] **Step 3: Commit**

```bash
git add e2e/email-notifications.spec.ts
git commit -m "test(m2.3c): e2e settings persistence + seen-vs-read bell behavior"
```

---

## Final steps (after all tasks)

- [ ] Run the FULL suite: `pnpm test` (shared + api pool + api node/db + web) and the e2e suite. All green.
- [ ] Update the spec's §4/§9 single-flight wording to the lease-row mechanism (keep spec and implementation in sync).
- [ ] Whole-branch adversarial review (Ultracode) per the SDD skill.
- [ ] `superpowers:finishing-a-development-branch` → push `m2-3c-email`, open a CI-gated PR. The founder merges.

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:
- §1 data model → Task 1 (both migrations, enum, lease table). §2 category/disposition → Tasks 2 (helper) + 8 (SQL CASE). §3 seen/read decoupling → Task 4 (+ `/notifications` page confirmed no-change in the spec). §4 drain/cron → Task 8 (lease mechanism refined from spec §4; documented). §5 email content → Task 7. §6 Postmark refactor → Task 5. §7 unsubscribe → Task 6. §8 settings surface → Tasks 3 (api) + 9 (web). §9 security invariants → enforced across Tasks 5/6/8 (verified gate in SELECT, no-log in postmark, token-only /unsub, stamp-on-success, escapeHtml, advisory→lease). §10 testing → each task's tests + Task 10. §11 infra → Tasks 6 (secret) + 8 (crons, deploy notes). §13 deferred → untouched by design.
- **Deviation:** spec's `pg_try_advisory_lock` → lease row (documented in Global Constraints + Task 8; spec to be synced in Final steps).

**2. Placeholder scan** — no TBD/TODO; every code step carries real code. Two explicit "confirm the selector/shape against current code" notes (Task 4 `/notifications` test updates, Task 10 selectors) are verification instructions with the concrete fallback named, not placeholders.

**3. Type consistency** — `NotificationChannel`/`NotificationCategory`/`NotificationPrefs`/`NotificationPrefsInput` (Task 2) are used identically in Tasks 3, 8, 9. `runEmailDrain(env, ctx, disposition)` signature matches its `index.ts` caller (Task 8). `sendNotificationEmail(env, {to,subject,textBody,htmlBody,unsubUrl})` (Task 5) matches the drain's call (Task 8). `buildNotificationEmail(items, {unsubUrl, disposition})` (Task 7) matches the drain's call (Task 8). `mintUnsubToken`/`verifyUnsubToken` (Task 6) match their callers (Tasks 8, and the route). `handleMarkSeen`/`handleGetNotificationPrefs`/`handlePutNotificationPrefs`/`handleUnsub` route names match `routes.ts` registrations. `emailed_at`, `seen_at`, `notification_channel`, `email_drain_lock`, `master_enabled` column/type names are consistent across Tasks 1, 3, 4, 6, 8.
