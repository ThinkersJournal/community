# M4 Module 2a — Shared Admin Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Cloudflare Access–gated admin identity and the append-only `moderation_actions` audit log — the foundation that the review queue (2b), the enforcement ladder (2c), and the CSAM operator surface all sit on.

**Architecture:** Admin authority comes from a Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`) verified against the Access team's JWKS with WebCrypto — a **different trust domain from member sessions**, which are never consulted for admin authority. The audit log is a table with **no foreign keys** and a database-level immutability trigger, so it outlives its subjects and cannot be rewritten by the app role.

**Tech Stack:** Cloudflare Workers (workerd), Neon Postgres 18 (`uuidv7()`), node-pg-migrate SQL files, `pg` over Hyperdrive, vitest (`pool` = workerd, `node` = plain Node).

**Spec:** `docs/superpowers/specs/2026-09-06-m4-moderation-queue-design.md` (merged). Read §3.1, §9, §12 before starting.

## Global Constraints

- **PM ruling (2026-09-08): API-first, with a thin server-rendered admin on top. No SPA.** 2a builds the API half only.
- **`SessionData.roles` MUST NOT be used for authorization.** It exists, is always `[]`, and is never read anywhere. Member sessions are the wrong trust domain for moderator authority.
- **`moderation_actions` has NO foreign keys.** `ON DELETE SET NULL` performs an *UPDATE* on the log, which the immutability trigger refuses — that combination makes posts and users undeletable and breaks GDPR erasure. This was a real defect caught in review; do not "restore" the FKs.
- **AC-2 (binding, spec §12): the immutability trigger MUST be proven to reject both an UPDATE and a DELETE.** A guard never shown to fire is not a guard.
- **Migrations:** one file, `-- Up Migration` / `-- Down Migration` markers, `uuidv7()` PKs. Mirror `0012_moderation.sql`.
- **Every error response goes through `errorResponse(code, status)`** from `src/http/errors.ts`. Hand-rolled `new Response("nope", {status})` fails `test/error-envelope.test.ts`.
- **Every route goes in the `ROUTES` table** in `src/routes.ts`. `test/route-protection.test.ts` imports it as its inventory.
- Out of scope for 2a: the review queue (2b), ladder/appeals (2c), `users` account-status columns (**issue #35**), DSA intake.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/migrations/0013_moderation_actions.sql` | **Create.** The table, its indexes, and the immutability trigger. |
| `apps/api/src/admin/access-jwt.ts` | **Create.** Verify an Access JWT against the team JWKS. Pure verification — no HTTP framing. |
| `apps/api/src/admin/require-admin.ts` | **Create.** The route-level gate: `AdminIdentity` or a 401 `Response`. |
| `apps/api/src/moderation/actions.ts` | **Create.** `recordModerationAction` — the one way a row is written. |
| `apps/api/src/routes/admin.ts` | **Create.** `GET /admin/whoami`, the first Access-gated route; proves the gate end to end. |
| `apps/api/src/routes.ts` | **Modify.** Register the route. |
| `packages/shared/src/errors.ts` | **Modify.** Add `ADMIN_REQUIRED`. |
| `apps/api/src/worker-configuration.d.ts` | **Modify** (regenerated). `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`. |
| `apps/api/test/moderation-actions-schema.db.test.ts` | **Create.** Schema + **AC-2**. |
| `apps/api/test/migrations.db.test.ts` | **Modify.** 0013 in the down/up round-trip. |
| `apps/api/test/admin-access-jwt.test.ts` | **Create.** JWT verification, real keys, stubbed JWKS. |
| `apps/api/test/admin-route.test.ts` | **Create.** The gate over the real router. |

**Config values.** `CF_ACCESS_TEAM_DOMAIN` (e.g. `thinkersjournal.cloudflareaccess.com`) and `CF_ACCESS_AUD` (the Access application's AUD tag) are **not secret**. Supply them exactly like `TEST_ROUTES`/`PREVIEW_ORIGIN`: `apps/api/.dev.vars` locally, `miniflare.bindings` in `vitest.config.ts` for tests, `--var` at deploy. Do **not** add a `vars` block to `wrangler.jsonc` (there is none today, deliberately).

---

## Task 1: Migration 0013 — `moderation_actions` + immutability trigger

**Files:**
- Create: `apps/api/migrations/0013_moderation_actions.sql`
- Create: `apps/api/test/moderation-actions-schema.db.test.ts`
- Modify: `apps/api/test/migrations.db.test.ts` (the down/up round-trip assertions)

**Interfaces:**
- Consumes: nothing.
- Produces: table `moderation_actions` with columns `id, actor_admin, action, post_id, comment_id, subject_user_id, subject_label, violation_category, action_expires_at, reason, internal_note, created_at`.

- [ ] **Step 1: Write the failing schema + AC-2 test**

Create `apps/api/test/moderation-actions-schema.db.test.ts`:

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

async function insertOne(): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO moderation_actions (actor_admin, action, reason)
     VALUES ('probe@example.com', 'content_restore', 'because') RETURNING id`,
  );
  return rows[0]!.id;
}

describe("moderation_actions (0013)", () => {
  it("has the expected columns with the expected nullability", async () => {
    const { rows } = await client.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'moderation_actions'`,
    );
    const byName = new Map(rows.map((r) => [r.column_name, r.is_nullable]));
    expect(byName.get("id")).toBe("NO");
    expect(byName.get("actor_admin")).toBe("NO");
    expect(byName.get("action")).toBe("NO");
    expect(byName.get("reason")).toBe("NO");
    expect(byName.get("created_at")).toBe("NO");
    for (const nullable of [
      "post_id", "comment_id", "subject_user_id", "subject_label",
      "violation_category", "action_expires_at", "internal_note",
    ]) {
      expect(byName.get(nullable), `${nullable} must be nullable`).toBe("YES");
    }
  });

  it("⚠️ has NO foreign keys — the log must outlive its subjects", async () => {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM information_schema.table_constraints
        WHERE table_schema = 'public' AND table_name = 'moderation_actions'
          AND constraint_type = 'FOREIGN KEY'`,
    );
    expect(
      Number(rows[0]!.n),
      "An FK with ON DELETE SET NULL performs an UPDATE on this table, which the immutability trigger refuses — that makes posts and users UNDELETABLE and breaks GDPR erasure.",
    ).toBe(0);
  });

  it("rejects an unknown action value", async () => {
    await expect(
      client.query(
        `INSERT INTO moderation_actions (actor_admin, action, reason)
         VALUES ('probe@example.com', 'not_a_real_action', 'x')`,
      ),
    ).rejects.toThrow();
  });

  it("rejects an unknown violation_category", async () => {
    await expect(
      client.query(
        `INSERT INTO moderation_actions (actor_admin, action, reason, violation_category)
         VALUES ('probe@example.com', 'user_warn', 'x', 'not_a_category')`,
      ),
    ).rejects.toThrow();
  });

  // ⚠️ AC-2 (spec §12), BINDING. A guard never shown to fire is not a guard.
  describe("AC-2 — the append-only trigger actually fires", () => {
    it("REJECTS an UPDATE", async () => {
      const id = await insertOne();
      await expect(
        client.query(`UPDATE moderation_actions SET reason = 'tampered' WHERE id = $1`, [id]),
      ).rejects.toThrow(/append-only/i);
    });

    it("REJECTS a DELETE", async () => {
      const id = await insertOne();
      await expect(
        client.query(`DELETE FROM moderation_actions WHERE id = $1`, [id]),
      ).rejects.toThrow(/append-only/i);
    });

    it("still ALLOWS an INSERT (control — the table is not simply broken)", async () => {
      const id = await insertOne();
      const { rows } = await client.query(`SELECT id FROM moderation_actions WHERE id = $1`, [id]);
      expect(rows).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 2: Run it and verify it FAILS**

Run: `cd apps/api && ./node_modules/.bin/vitest run --project node test/moderation-actions-schema.db.test.ts`
Expected: FAIL — `relation "moderation_actions" does not exist`.

- [ ] **Step 3: Write the migration**

Create `apps/api/migrations/0013_moderation_actions.sql`:

```sql
-- Up Migration
-- M4 module 2a: the append-only moderation audit log. The compliance record
-- behind DSA statements of reasons and the evidence base for appeals.
--
-- ⚠️ NO FOREIGN KEYS, DELIBERATELY. `ON DELETE SET NULL` performs an UPDATE on
-- this table, which the immutability trigger below REFUSES -- so FKs here would
-- make posts and users UNDELETABLE and break GDPR erasure. An append-only log
-- must OUTLIVE its subjects; referential actions on it are semantically wrong.
-- A dangling post_id after a post is deleted is CORRECT for an audit record,
-- and `subject_label` preserves the readability a bare uuid loses.
CREATE TABLE moderation_actions (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  -- The Cloudflare Access identity (email) of the human who acted, or 'system'.
  -- Text, not a FK: moderators are Access principals and need not be members.
  actor_admin       text NOT NULL,
  action            text NOT NULL CHECK (action IN (
                      'content_restore','content_keep_hidden','content_remove',
                      'user_warn','user_suspend','user_ban','user_terminate',
                      'appeal_granted','appeal_denied')),
  post_id           uuid,
  comment_id        uuid,
  subject_user_id   uuid,
  subject_label     text,
  violation_category text CHECK (violation_category IN
                      ('spam','harassment','hate','sexual','violence','ip_infringement','other')),
  -- A suspension's intended end, recorded ON the action so the log stays
  -- truthful after users.suspended_until moves on. An audit log records what
  -- was DONE; it must never depend on current state to explain itself.
  action_expires_at timestamptz,
  reason            text NOT NULL,
  internal_note     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX moderation_actions_post_idx     ON moderation_actions (post_id, created_at)    WHERE post_id IS NOT NULL;
CREATE INDEX moderation_actions_comment_idx  ON moderation_actions (comment_id, created_at) WHERE comment_id IS NOT NULL;
CREATE INDEX moderation_actions_subject_idx  ON moderation_actions (subject_user_id, created_at);
CREATE INDEX moderation_actions_category_idx ON moderation_actions (violation_category, created_at);

-- APPEND-ONLY, ENFORCED IN THE DATABASE. The app role has DML, so discipline
-- alone is not a guard. AC-2 requires this trigger be PROVEN to reject both an
-- UPDATE and a DELETE.
CREATE FUNCTION moderation_actions_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'moderation_actions is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER moderation_actions_no_update
  BEFORE UPDATE OR DELETE ON moderation_actions
  FOR EACH ROW EXECUTE FUNCTION moderation_actions_immutable();

-- Down Migration
DROP TRIGGER IF EXISTS moderation_actions_no_update ON moderation_actions;
DROP FUNCTION IF EXISTS moderation_actions_immutable();
DROP TABLE IF EXISTS moderation_actions;
```

- [ ] **Step 4: Apply and verify the test PASSES**

Run: `cd apps/api && node scripts/migrate.mjs test up && ./node_modules/.bin/vitest run --project node test/moderation-actions-schema.db.test.ts`
Expected: PASS, all 7 assertions — including both AC-2 rejection cases and the INSERT control.

- [ ] **Step 5: Add 0013 to the migration round-trip**

In `apps/api/test/migrations.db.test.ts`, alongside the existing `blocks`/`reports` assertions, add `expect(await tableExists(client, "moderation_actions")).toBe(true);` to **both** "up" blocks and `...toBe(false);` to the "down" block. This proves 0013 is reversible, not just applicable.

- [ ] **Step 6: Run the whole node project**

Run: `cd apps/api && ./node_modules/.bin/vitest run --project node`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/0013_moderation_actions.sql apps/api/test/moderation-actions-schema.db.test.ts apps/api/test/migrations.db.test.ts
git commit -m "feat(m4): append-only moderation_actions audit log (migration 0013)"
```

---

## Task 2: `recordModerationAction`

**Files:**
- Create: `apps/api/src/moderation/actions.ts`
- Create: `apps/api/test/moderation-actions.db.test.ts`

**Interfaces:**
- Consumes: Task 1's table; `pg.Client` (callers pass their own, per `src/moderation/auto-hide.ts` and `is-blocked.ts` — these helpers never open a connection).
- Produces:
  ```ts
  export type ModerationActionKind =
    | "content_restore" | "content_keep_hidden" | "content_remove"
    | "user_warn" | "user_suspend" | "user_ban" | "user_terminate"
    | "appeal_granted" | "appeal_denied";
  export type ViolationCategory =
    | "spam" | "harassment" | "hate" | "sexual" | "violence" | "ip_infringement" | "other";
  export interface ModerationActionInput {
    actorAdmin: string; action: ModerationActionKind; reason: string;
    postId?: string; commentId?: string; subjectUserId?: string; subjectLabel?: string;
    violationCategory?: ViolationCategory; actionExpiresAt?: Date; internalNote?: string;
  }
  export async function recordModerationAction(c: Client, input: ModerationActionInput): Promise<string>;
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/moderation-actions.db.test.ts`:

```ts
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recordModerationAction } from "../src/moderation/actions";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;
beforeAll(async () => { client = new Client({ connectionString: TEST_DATABASE_URL }); await client.connect(); });
afterAll(async () => { await client.end(); });

describe("recordModerationAction", () => {
  it("writes a row and returns its id", async () => {
    const id = await recordModerationAction(client, {
      actorAdmin: "mod@example.com",
      action: "user_warn",
      reason: "first warning",
      violationCategory: "spam",
    });
    const { rows } = await client.query<{ actor_admin: string; action: string; violation_category: string }>(
      `SELECT actor_admin, action, violation_category FROM moderation_actions WHERE id = $1`, [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_admin).toBe("mod@example.com");
    expect(rows[0]!.action).toBe("user_warn");
    expect(rows[0]!.violation_category).toBe("spam");
  });

  it("persists action_expires_at for a suspension", async () => {
    const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const id = await recordModerationAction(client, {
      actorAdmin: "mod@example.com", action: "user_suspend",
      reason: "7 day suspension", actionExpiresAt: expires,
    });
    const { rows } = await client.query<{ action_expires_at: Date }>(
      `SELECT action_expires_at FROM moderation_actions WHERE id = $1`, [id],
    );
    expect(rows[0]!.action_expires_at.getTime()).toBeCloseTo(expires.getTime(), -3);
  });

  it("leaves optional columns NULL when not supplied", async () => {
    const id = await recordModerationAction(client, {
      actorAdmin: "system", action: "content_restore", reason: "restored on review",
    });
    const { rows } = await client.query<{ post_id: string | null; internal_note: string | null }>(
      `SELECT post_id, internal_note FROM moderation_actions WHERE id = $1`, [id],
    );
    expect(rows[0]!.post_id).toBeNull();
    expect(rows[0]!.internal_note).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and verify it FAILS**

Run: `cd apps/api && ./node_modules/.bin/vitest run --project node test/moderation-actions.db.test.ts`
Expected: FAIL — cannot resolve `../src/moderation/actions`.

- [ ] **Step 3: Implement**

Create `apps/api/src/moderation/actions.ts`:

```ts
/**
 * THE ONE WAY a `moderation_actions` row is written.
 *
 * ⚠️ There is no update and no delete, by construction: the table carries a
 * database-level trigger that refuses both (migration 0013). This module
 * therefore exposes an INSERT and nothing else — if you find yourself wanting
 * to "correct" a row, the correct act is to append a new one.
 *
 * Takes the caller's existing `pg.Client` and never opens its own connection,
 * matching `auto-hide.ts` and `is-blocked.ts`.
 */
import type { Client } from "pg";

export type ModerationActionKind =
  | "content_restore" | "content_keep_hidden" | "content_remove"
  | "user_warn" | "user_suspend" | "user_ban" | "user_terminate"
  | "appeal_granted" | "appeal_denied";

export type ViolationCategory =
  | "spam" | "harassment" | "hate" | "sexual" | "violence" | "ip_infringement" | "other";

export interface ModerationActionInput {
  /** Access identity (email) of the acting human, or "system" for automation. */
  readonly actorAdmin: string;
  readonly action: ModerationActionKind;
  /** The statement of reasons (DSA). Shown to the user. */
  readonly reason: string;
  readonly postId?: string;
  readonly commentId?: string;
  readonly subjectUserId?: string;
  /** Denormalized identity captured at action time; the log must stay readable after deletion. */
  readonly subjectLabel?: string;
  readonly violationCategory?: ViolationCategory;
  readonly actionExpiresAt?: Date;
  /** Never shown to the user. */
  readonly internalNote?: string;
}

export async function recordModerationAction(
  c: Client,
  input: ModerationActionInput,
): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO moderation_actions
       (actor_admin, action, post_id, comment_id, subject_user_id, subject_label,
        violation_category, action_expires_at, reason, internal_note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      input.actorAdmin,
      input.action,
      input.postId ?? null,
      input.commentId ?? null,
      input.subjectUserId ?? null,
      input.subjectLabel ?? null,
      input.violationCategory ?? null,
      input.actionExpiresAt ?? null,
      input.reason,
      input.internalNote ?? null,
    ],
  );
  return rows[0]!.id;
}
```

- [ ] **Step 4: Run and verify it PASSES**

Run: `cd apps/api && ./node_modules/.bin/vitest run --project node test/moderation-actions.db.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/moderation/actions.ts apps/api/test/moderation-actions.db.test.ts
git commit -m "feat(m4): recordModerationAction — the only writer of the audit log"
```

---

## Task 3: Cloudflare Access JWT verification

**Files:**
- Create: `apps/api/src/admin/access-jwt.ts`
- Create: `apps/api/test/admin-access-jwt.test.ts`
- Modify: `apps/api/vitest.config.ts` (add the two config bindings)

**Interfaces:**
- Consumes: `env.CF_ACCESS_TEAM_DOMAIN`, `env.CF_ACCESS_AUD`.
- Produces:
  ```ts
  export interface AdminIdentity { readonly email: string; readonly sub: string; }
  export async function verifyAccessJwt(token: string, teamDomain: string, aud: string): Promise<AdminIdentity | null>;
  export function __resetJwksCacheForTests(): void;
  ```

- [ ] **Step 1: Add the config bindings to the test pool**

In `apps/api/vitest.config.ts`, inside `miniflare.bindings` (beside `TURNSTILE_SECRET_KEY` etc.), add:

```ts
                // Cloudflare Access config for the admin gate (M4 2a). NOT
                // secrets — the team domain and AUD tag are public identifiers —
                // but supplied here for the same reason as the others: the suite
                // must be CI-safe without .dev.vars existing.
                CF_ACCESS_TEAM_DOMAIN: "testteam.cloudflareaccess.com",
                CF_ACCESS_AUD: "test-aud-tag",
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/test/admin-access-jwt.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetJwksCacheForTests, verifyAccessJwt } from "../src/admin/access-jwt";

const TEAM = "testteam.cloudflareaccess.com";
const AUD = "test-aud-tag";
const KID = "test-key-1";

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (o: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(o)));

let keyPair: CryptoKeyPair;

/** Sign a JWT with the test key. Claims are merged over a valid baseline. */
async function makeJwt(claims: Record<string, unknown> = {}, kid = KID): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: "RS256", kid, typ: "JWT" });
  const payload = b64urlJson({
    iss: `https://${TEAM}`, aud: [AUD], sub: "user-sub-1",
    email: "mod@example.com", iat: now, exp: now + 600, ...claims,
  });
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, data);
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

beforeEach(async () => {
  keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  __resetJwksCacheForTests();
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }), {
      status: 200, headers: { "content-type": "application/json" },
    })));
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("verifyAccessJwt", () => {
  it("accepts a valid token and returns the identity", async () => {
    const id = await verifyAccessJwt(await makeJwt(), TEAM, AUD);
    expect(id).toEqual({ email: "mod@example.com", sub: "user-sub-1" });
  });

  it("rejects a token whose signature does not verify", async () => {
    const token = await makeJwt();
    const tampered = `${token.slice(0, -4)}AAAA`;
    expect(await verifyAccessJwt(tampered, TEAM, AUD)).toBeNull();
  });

  it("rejects the wrong audience", async () => {
    expect(await verifyAccessJwt(await makeJwt({ aud: ["someone-elses-app"] }), TEAM, AUD)).toBeNull();
  });

  it("rejects the wrong issuer", async () => {
    expect(await verifyAccessJwt(await makeJwt({ iss: "https://evil.cloudflareaccess.com" }), TEAM, AUD)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    expect(await verifyAccessJwt(await makeJwt({ exp: past }), TEAM, AUD)).toBeNull();
  });

  it("rejects an unknown kid", async () => {
    expect(await verifyAccessJwt(await makeJwt({}, "some-other-kid"), TEAM, AUD)).toBeNull();
  });

  it("rejects a malformed token", async () => {
    expect(await verifyAccessJwt("not.a.jwt", TEAM, AUD)).toBeNull();
    expect(await verifyAccessJwt("", TEAM, AUD)).toBeNull();
  });

  it("⚠️ rejects alg=none — the classic JWT bypass", async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = b64urlJson({ alg: "none", kid: KID, typ: "JWT" });
    const payload = b64urlJson({ iss: `https://${TEAM}`, aud: [AUD], sub: "s", email: "e@x", exp: now + 600 });
    expect(await verifyAccessJwt(`${header}.${payload}.`, TEAM, AUD)).toBeNull();
  });

  it("caches the JWKS rather than refetching per call", async () => {
    await verifyAccessJwt(await makeJwt(), TEAM, AUD);
    await verifyAccessJwt(await makeJwt(), TEAM, AUD);
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run it and verify it FAILS**

Run: `cd apps/api && ./node_modules/.bin/vitest run --project pool test/admin-access-jwt.test.ts`
Expected: FAIL — cannot resolve `../src/admin/access-jwt`.

- [ ] **Step 4: Implement**

Create `apps/api/src/admin/access-jwt.ts`:

```ts
/**
 * Cloudflare Access JWT verification — the ONLY source of admin authority.
 *
 * ⚠️ A DIFFERENT TRUST DOMAIN FROM MEMBER SESSIONS. `SessionData.roles` exists,
 * is always `[]`, and is never read for authorization anywhere. A member
 * session must never confer moderator authority: the admin surface sits behind
 * Cloudflare Access, and the Access JWT is what proves an operator.
 *
 * ⚠️ THE SIGNATURE IS CHECKED BEFORE ANY CLAIM IS TRUSTED, and `alg` is pinned
 * to RS256. Reading claims from an unverified token — or honouring the `alg`
 * the token itself asks for — is the classic JWT bypass.
 *
 * Never throws: every failure returns `null`, so a caller cannot accidentally
 * treat a thrown error as an authenticated request.
 */
export interface AdminIdentity {
  readonly email: string;
  readonly sub: string;
}

interface Jwk { kid?: string; alg?: string; kty?: string; n?: string; e?: string }

const JWKS_TTL_MS = 3_600_000; // 1h

let cache: { teamDomain: string; fetchedAt: number; keys: Map<string, CryptoKey> } | null = null;

/** Test seam — the module-level cache would otherwise leak between test cases. */
export function __resetJwksCacheForTests(): void {
  cache = null;
}

function b64urlToBytes(s: string): Uint8Array | null {
  try {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function b64urlToJson<T>(s: string): T | null {
  const bytes = b64urlToBytes(s);
  if (bytes === null) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

async function loadKeys(teamDomain: string): Promise<Map<string, CryptoKey>> {
  if (cache !== null && cache.teamDomain === teamDomain && Date.now() - cache.fetchedAt < JWKS_TTL_MS) {
    return cache.keys;
  }
  const keys = new Map<string, CryptoKey>();
  try {
    const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { keys?: Jwk[] };
      for (const jwk of body.keys ?? []) {
        if (jwk.kid === undefined) continue;
        try {
          keys.set(
            jwk.kid,
            await crypto.subtle.importKey(
              "jwk",
              { ...jwk, alg: "RS256", ext: true, key_ops: ["verify"] } as JsonWebKey,
              { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
              false,
              ["verify"],
            ),
          );
        } catch {
          // A single unusable key must not discard the rest of the set.
        }
      }
    }
  } catch (err) {
    console.error("access jwks fetch failed", { err });
  }
  cache = { teamDomain, fetchedAt: Date.now(), keys };
  return keys;
}

export async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  aud: string,
): Promise<AdminIdentity | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [rawHeader, rawPayload, rawSig] = parts as [string, string, string];

  const header = b64urlToJson<{ alg?: string; kid?: string }>(rawHeader);
  // ⚠️ Pin the algorithm. `alg: "none"`, and any alg swap, dies here.
  if (header === null || header.alg !== "RS256" || typeof header.kid !== "string") return null;

  const keys = await loadKeys(teamDomain);
  const key = keys.get(header.kid);
  if (key === undefined) return null;

  const sig = b64urlToBytes(rawSig);
  if (sig === null) return null;

  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    sig,
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
  );
  if (!ok) return null;

  const claims = b64urlToJson<{
    iss?: string; aud?: string | string[]; sub?: string; email?: string; exp?: number; nbf?: number;
  }>(rawPayload);
  if (claims === null) return null;

  if (claims.iss !== `https://${teamDomain}`) return null;

  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud === undefined ? [] : [claims.aud];
  if (!audiences.includes(aud)) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) return null;
  if (typeof claims.nbf === "number" && claims.nbf > now) return null;

  if (typeof claims.email !== "string" || typeof claims.sub !== "string") return null;
  return { email: claims.email, sub: claims.sub };
}
```

- [ ] **Step 5: Run and verify it PASSES**

Run: `cd apps/api && ./node_modules/.bin/vitest run --project pool test/admin-access-jwt.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/admin/access-jwt.ts apps/api/test/admin-access-jwt.test.ts apps/api/vitest.config.ts
git commit -m "feat(m4): verify Cloudflare Access JWTs as the admin trust domain"
```

---

## Task 4: The `requireAdmin` gate and `GET /admin/whoami`

**Files:**
- Create: `apps/api/src/admin/require-admin.ts`
- Create: `apps/api/src/routes/admin.ts`
- Modify: `apps/api/src/routes.ts`
- Modify: `packages/shared/src/errors.ts`
- Modify: `apps/api/src/worker-configuration.d.ts` (regenerate)
- Create: `apps/api/test/admin-route.test.ts`

**Interfaces:**
- Consumes: `verifyAccessJwt` and `AdminIdentity` from Task 3.
- Produces: `export async function requireAdmin(request: Request, env: Env): Promise<AdminIdentity | Response>;` and `handleAdminWhoami`.

- [ ] **Step 1: Add the error code**

In `packages/shared/src/errors.ts`, in the `--- authorization ---` group:

```ts
  | "ADMIN_REQUIRED"         // 401 — no valid Cloudflare Access identity (M4 2a)
```

- [ ] **Step 2: Regenerate Worker types**

Run: `cd apps/api && ./node_modules/.bin/wrangler types ./src/worker-configuration.d.ts`
Then add the two config values to the `Env` interface if the generator did not (they are supplied via `.dev.vars`/`--var`, not `wrangler.jsonc`, exactly like `TEST_ROUTES`):

```ts
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
```

⚠️ Review the generated diff before committing — `wrangler types` has previously rewritten unrelated parts of this file. Revert anything you did not intend.

- [ ] **Step 3: Write the failing test**

Create `apps/api/test/admin-route.test.ts`:

```ts
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { __resetJwksCacheForTests } from "../src/admin/access-jwt";

const TEAM = "testteam.cloudflareaccess.com";
const AUD = "test-aud-tag";
const KID = "test-key-1";

const b64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (o: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(o)));

let keyPair: CryptoKeyPair;

async function makeJwt(claims: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = b64urlJson({
    iss: `https://${TEAM}`, aud: [AUD], sub: "user-sub-1",
    email: "mod@example.com", exp: now + 600, ...claims,
  });
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

async function call(headers: Record<string, string> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://api.test/admin/whoami", { headers }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeEach(async () => {
  keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  __resetJwksCacheForTests();
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }),
      { status: 200, headers: { "content-type": "application/json" } })));
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("GET /admin/whoami", () => {
  it("401s with ADMIN_REQUIRED when the Access header is absent", async () => {
    const res = await call();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: "ADMIN_REQUIRED" });
  });

  it("401s when the Access JWT is invalid", async () => {
    const res = await call({ "Cf-Access-Jwt-Assertion": "not.a.jwt" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: "ADMIN_REQUIRED" });
  });

  it("200s with the admin identity for a valid Access JWT", async () => {
    const res = await call({ "Cf-Access-Jwt-Assertion": await makeJwt() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "mod@example.com", sub: "user-sub-1" });
  });

  it("⚠️ a member session confers NO admin authority", async () => {
    // Deliberately no Access header — only a session cookie. Member sessions are
    // a different trust domain and must never satisfy the admin gate.
    const res = await call({ cookie: "tj_session=whatever-a-member-would-send" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: "ADMIN_REQUIRED" });
  });
});
```

- [ ] **Step 4: Run it and verify it FAILS**

Run: `cd apps/api && ./node_modules/.bin/vitest run --project pool test/admin-route.test.ts`
Expected: FAIL — the route is not registered, so all four get the generic 404 envelope.

- [ ] **Step 5: Implement the gate**

Create `apps/api/src/admin/require-admin.ts`:

```ts
/**
 * The admin gate. Returns an `AdminIdentity`, or a `Response` the caller must
 * return unchanged — the same shape as `runMutatingPipeline`.
 *
 * ⚠️ FOR FUTURE MUTATING ADMIN ROUTES (module 2b): admin routes do NOT run
 * `runMutatingPipeline`, because that pipeline authenticates a MEMBER SESSION
 * and admins are Access principals. The first non-GET admin route must
 * therefore be added to `PIPELINE_EXEMPT` in test/route-protection.test.ts with
 * a written justification — and it MUST also call `checkOrigin` inline, exactly
 * as signup and login do. Cloudflare injects the Access header from the
 * `CF_Authorization` COOKIE, so a cross-site form post from a logged-in
 * moderator's browser WOULD carry a valid Access assertion. Access proves WHO;
 * it does not prove the request was intended.
 */
import { errorResponse } from "../http/errors";

import { verifyAccessJwt, type AdminIdentity } from "./access-jwt";

export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

export async function requireAdmin(request: Request, env: Env): Promise<AdminIdentity | Response> {
  const token = request.headers.get(ACCESS_JWT_HEADER);
  if (token === null || token === "") return errorResponse("ADMIN_REQUIRED", 401);

  const identity = await verifyAccessJwt(token, env.CF_ACCESS_TEAM_DOMAIN, env.CF_ACCESS_AUD);
  // ⚠️ One code and one status for every failure — absent, malformed, expired,
  // wrong audience. A distinguishable rejection tells an attacker which half of
  // the credential to keep working on.
  if (identity === null) return errorResponse("ADMIN_REQUIRED", 401);

  return identity;
}
```

Create `apps/api/src/routes/admin.ts`:

```ts
/**
 * The Access-gated admin surface (M4 2a).
 *
 * `GET /admin/whoami` is deliberately the whole of 2a's HTTP surface: it proves
 * the gate end to end — JWKS fetch, signature check, issuer/audience/expiry —
 * without inventing a feature the queue module has not designed yet.
 */
import { requireAdmin } from "../admin/require-admin";

export async function handleAdminWhoami(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  return new Response(JSON.stringify({ email: admin.email, sub: admin.sub }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
```

- [ ] **Step 6: Register the route**

In `apps/api/src/routes.ts`, add the import beside the others:

```ts
import { handleAdminWhoami } from "./routes/admin";
```

and add the entry to the `ROUTES` array:

```ts
  { method: "GET", pattern: "/admin/whoami", handler: handleAdminWhoami },
```

- [ ] **Step 7: Run and verify it PASSES**

Run: `cd apps/api && ./node_modules/.bin/vitest run --project pool test/admin-route.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Run the FULL suite — this task touches shared types and the route table**

Run: `cd apps/api && ./node_modules/.bin/vitest run` and `cd apps/api && npm run typecheck`
Expected: PASS. `test/route-protection.test.ts` and `test/error-envelope.test.ts` both import `ROUTES`; a new route must satisfy both. `GET /admin/whoami` is a GET (so `PIPELINE_EXEMPT` does not apply) and returns a proper `{code}` envelope on failure (so no error-envelope allowlist entry is needed). **If either fails, fix the route — do not add an allowlist entry to quiet it.**

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/admin/require-admin.ts apps/api/src/routes/admin.ts apps/api/src/routes.ts \
        apps/api/src/worker-configuration.d.ts packages/shared/src/errors.ts apps/api/test/admin-route.test.ts
git commit -m "feat(m4): Access-gated admin identity + GET /admin/whoami"
```

---

## Deployment note (not a task)

Before the admin surface is reachable in production, an Access application must exist for the admin path and `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` must be set on the deployed Worker. **Until then `GET /admin/whoami` answers 401 to everyone, which is the correct default** — the gate fails closed. Setting up the Access application is a dashboard action for the founder, not a code change, and it is deliberately NOT a prerequisite for merging 2a.

---

## Self-Review

**Spec coverage.** §3.1 (`moderation_actions`, no FKs, trigger, `violation_category`, `action_expires_at`) → Task 1. §9 (Access gate, admin identity, `roles` unused) → Tasks 3–4. §12 **AC-2** → Task 1 Step 1, with both rejection cases and an INSERT control. §3.2 (`users` status) and AC-3/AC-4 are **issue #35**, deliberately out of scope. AC-1 and AC-5 belong to 2b/2c.

**Placeholder scan.** No TBD/TODO; every step carries the code or the exact command.

**Type consistency.** `AdminIdentity` `{email, sub}` is produced in Task 3 and consumed unchanged in Task 4. `recordModerationAction(c, input) → Promise<string>` (Task 2) is not called by any 2a route — it is written and tested here because 2b/2c and the CSAM pipeline all consume it, and the table it writes to lands in Task 1. `ModerationActionKind` matches the migration's CHECK list exactly, and `ViolationCategory` matches both the migration's CHECK and the 7 report reasons in `0012_moderation.sql`.

**One gap deliberately left.** Task 2's helper has no production caller until 2b. That is intentional: the audit log is the *shared* foundation, and shipping the writer with the table keeps the schema and its only writer in one reviewable slice.
