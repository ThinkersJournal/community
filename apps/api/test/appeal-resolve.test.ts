import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src";
import { __resetJwksCacheForTests } from "../src/admin/access-jwt";
import { anonymiseExpiredAccounts } from "../src/auth/anonymise-accounts";
import { withClient } from "../src/db/client";
import { applyAccountAction } from "../src/moderation/account-actions";
import { fileAppeal, resolveAppeal } from "../src/moderation/appeals";
import { applyDecision, applyDecisionInTx } from "../src/moderation/decide";
import { createPublished, createVerifiedActor, deleteCreatedUsers } from "./actor";
import { withAnonymiseReaperLock } from "./helpers/anonymise-reaper-lock";

import type { AdminAppealResolveResponse, AdminAppealsResponse } from "@thinkersjournal/shared";

/**
 * #113 plan B, Task 6 — resolving an appeal: `resolveAppeal` (a grant applies
 * the inverse action in the SAME transaction as the `appeal_granted` row and
 * the appeal's resolution), and the admin routes `GET /admin/appeals` and
 * `POST /admin/appeals/:id/resolve`.
 */

const madeUsers: string[] = [];
const madeNotices: string[] = [];

const TEAM = "testteam.cloudflareaccess.com";
const AUD = "test-aud-tag";
const KID = "test-key-1";
const ALLOWED_ORIGIN = "http://localhost:8787";
const PASSWORD = "a-brand-new-password-123";

let keyPair: CryptoKeyPair;
let sentEmails: Array<Record<string, unknown>> = [];
let adminEmail: string;

async function ctxRun<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

beforeEach(async () => {
  sentEmails = [];
  adminEmail = `mod-${crypto.randomUUID()}@example.test`;
  keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  __resetJwksCacheForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://api.postmarkapp.com/email") {
        sentEmails.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ ErrorCode: 0, Message: "OK", MessageID: "test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("https://challenges.cloudflare.com/")) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      // Default: the Access JWKS.
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(async () => {
  // Notices first: dsa_notices' post_id is ON DELETE SET NULL, so deleting the
  // post would not take them with it.
  if (madeNotices.length > 0) await ctxRun((c) => c.query(`DELETE FROM dsa_notices WHERE id = ANY($1::uuid[])`, [madeNotices]));
  madeNotices.length = 0;
  // appeals cascade with the user; moderation_actions rows stay (append-only, by design).
  if (madeUsers.length > 0) await ctxRun((c) => c.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [madeUsers]));
  madeUsers.length = 0;
  await deleteCreatedUsers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mkUser(opts: { handle?: boolean } = {}): Promise<string> {
  const id = crypto.randomUUID();
  await ctxRun(async (c) => {
    await c.query(`INSERT INTO users (id, email, password_hash, email_verified_at) VALUES ($1, $2, 'h', now())`, [
      id,
      `${id}@resolve.test`,
    ]);
    if (opts.handle === true) {
      await c.query(`INSERT INTO profiles (user_id, username) VALUES ($1, $2)`, [id, `r${id.replace(/-/g, "").slice(0, 20)}`]);
    }
  });
  madeUsers.push(id);
  return id;
}

/** Seed through the real primitive (ruling B2), never raw SQL: action_expires_at must be what applyAccountAction writes. */
async function suspend(userId: string, hours: 24 | 720): Promise<string> {
  const out = await ctxRun((c) =>
    applyAccountAction(c, {
      userId,
      kind: "suspend",
      suspensionHours: hours,
      reason: `suspended ${hours}h`,
      actorAdmin: "mod1@example.test",
      subjectLabel: "someone",
    }),
  );
  if (out.kind !== "applied") throw new Error(`seed suspend failed: ${out.kind}`);
  return out.actionId;
}

async function accountAction(userId: string, kind: "warn" | "ban" | "terminate"): Promise<string> {
  const out = await ctxRun((c) =>
    applyAccountAction(c, { userId, kind, reason: `${kind} reason`, actorAdmin: "mod1@example.test", subjectLabel: "someone" }),
  );
  if (out.kind !== "applied") throw new Error(`seed ${kind} failed: ${out.kind}`);
  return out.actionId;
}

async function appealOf(userId: string, actionId: string): Promise<string> {
  const filed = await ctxRun((c) => fileAppeal(c, { actionId, appellantId: userId, body: "please reconsider" }));
  if (filed.kind !== "filed") throw new Error(`seed appeal failed: ${filed.kind}`);
  return filed.appealId;
}

async function grant(appealId: string): Promise<void> {
  const out = await ctxRun((c) => resolveAppeal(c, { appealId, grant: true, reason: "upheld", actorAdmin: "mod2@example.test" }));
  expect(out.kind).toBe("resolved");
}

async function suspendedUntil(userId: string): Promise<number | null> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ suspended_until: Date | null }>(`SELECT suspended_until FROM users WHERE id = $1`, [userId]);
    return rows[0]!.suspended_until?.getTime() ?? null;
  });
}

async function ownEnd(actionId: string): Promise<number> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ action_expires_at: Date }>(`SELECT action_expires_at FROM moderation_actions WHERE id = $1`, [actionId]);
    return rows[0]!.action_expires_at.getTime();
  });
}

const DAY = 24 * 3600_000;

/**
 * Polls (every 50 ms, at most 2 s — under BEGIN_BOUNDED_TX's 5 s lock_timeout)
 * until some backend is waiting on a lock held by `holderPid`. Copied from
 * test/anonymise-accounts.test.ts's waitUntilBlockedBy (one level of
 * transitivity; never matches on query text).
 */
async function waitUntilBlockedBy(holderPid: number): Promise<boolean> {
  return ctxRun(async (c) => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const { rowCount } = await c.query(
        `SELECT 1
           FROM pg_stat_activity w
          WHERE pg_blocking_pids(w.pid) @> ARRAY[$1::int]
             OR EXISTS (SELECT 1 FROM unnest(pg_blocking_pids(w.pid)) AS bp(pid)
                         WHERE pg_blocking_pids(bp.pid) @> ARRAY[$1::int])`,
        [holderPid],
      );
      if ((rowCount ?? 0) > 0) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  });
}

describe("resolveAppeal — ⚠️ Review Focus 4: overlapping suspensions", () => {
  it("granting the LONG suspension's appeal ends the bar at the SHORT one's own end; granting both frees the account", async () => {
    const u = await mkUser();
    const long = await suspend(u, 720);
    const beforeShort = Date.now();
    const short = await suspend(u, 24); // on top: the bar stays at the long end (GREATEST)
    const afterShort = Date.now();
    // Control: the bar is the long one's end.
    expect(await suspendedUntil(u)).toBe(await ownEnd(long));

    await grant(await appealOf(u, long));
    // ⚠️ Pinned INDEPENDENTLY of action_expires_at (F2): the short suspension
    // was applied between beforeShort and afterShort for 24h, so the bar must
    // end within that window + 24h (the same tolerance as Task 1 Step 5). A
    // comparison against ownEnd(short) would read the very column B2 fixes.
    const bar = await suspendedUntil(u);
    expect(bar).not.toBeNull();
    expect(bar!).toBeGreaterThanOrEqual(beforeShort + DAY - 5_000);
    expect(bar!).toBeLessThanOrEqual(afterShort + DAY + 5_000);

    await grant(await appealOf(u, short));
    expect(await suspendedUntil(u)).toBeNull();
  });

  it("granting the SHORT one's appeal while the long one stands leaves the long end", async () => {
    const u = await mkUser();
    const long = await suspend(u, 720);
    const short = await suspend(u, 24);
    await grant(await appealOf(u, short));
    expect(await suspendedUntil(u)).toBe(await ownEnd(long));
  });

  it("⚠️ Review Focus 7 (F1): a suspension applied while a grant waits on the users row is NOT dropped", async () => {
    const u = await mkUser();
    const long = await suspend(u, 720);
    await suspend(u, 24);
    const appealLong = await appealOf(u, long);

    const ctx = createExecutionContext();
    let granting: Promise<unknown> | undefined;
    let newEnd = 0;
    try {
      await ctxRun(async (holder) => {
        await holder.query("BEGIN");
        try {
          await holder.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [u]);
          const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          const holderPid = rows[0]!.pid;
          // Started, not awaited: it must block on the holder's lock.
          granting = withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
            resolveAppeal(c, { appealId: appealLong, grant: true, reason: "upheld", actorAdmin: "mod2@example.test" }),
          );
          granting.catch(() => undefined);
          if (!(await waitUntilBlockedBy(holderPid))) {
            throw new Error(`timed out after 2s waiting for the grant to block on holder pid ${holderPid}`);
          }
          // A NEW 7-day suspension, exactly the two writes applyAccountAction
          // makes (it cannot run here: it opens its own transaction).
          await holder.query(
            `UPDATE users SET suspended_until = GREATEST(COALESCE(suspended_until, now()), now() + make_interval(hours => 168))
              WHERE id = $1`,
            [u],
          );
          const { rows: ins } = await holder.query<{ action_expires_at: Date }>(
            `INSERT INTO moderation_actions (actor_admin, action, subject_user_id, subject_label, action_expires_at, reason)
             VALUES ('mod3@example.test', 'user_suspend', $1, 'someone', now() + make_interval(hours => 168), 'concurrent')
             RETURNING action_expires_at`,
            [u],
          );
          newEnd = ins[0]!.action_expires_at.getTime();
          await holder.query("COMMIT");
        } catch (err) {
          try {
            await holder.query("ROLLBACK");
          } catch {
            // keep the root error
          }
          throw err;
        }
      });
      await granting;
    } finally {
      if (granting !== undefined) await Promise.allSettled([granting]);
      await waitOnExecutionContext(ctx);
    }
    // The long one is granted; the bar is the LATEST of what still stands: the
    // concurrent 7-day suspension (later than the 24h one). Without the lock,
    // the recompute's pre-wait snapshot never saw it and the bar would be ~24h.
    expect(await suspendedUntil(u)).toBe(newEnd);
  });
});

// ---- content helpers --------------------------------------------------------------

async function seedPost(authorId: string): Promise<string> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1, 'appealed post', $2, 'body', 'published', now()) RETURNING id`,
      [authorId, `resolve-${crypto.randomUUID().slice(0, 8)}`],
    );
    return rows[0]!.id;
  });
}

/** A moderator's real content decision (decide.ts), so the action row is exactly what production writes. */
async function decideOn(postId: string, decision: "keep_hidden" | "remove" | "restore", actorAdmin = "mod1@example.test"): Promise<string> {
  const result = await ctxRun((c) =>
    applyDecision(c, { subject: "post", subjectId: postId, decision, reason: `${decision} reason`, actorAdmin }),
  );
  if (result === null) throw new Error("seed decision found no post");
  return result.actionId;
}

async function hiddenAt(postId: string): Promise<Date | null> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ hidden_at: Date | null }>(`SELECT hidden_at FROM posts WHERE id = $1`, [postId]);
    return rows[0]!.hidden_at;
  });
}

interface AppealState {
  resolved_at: Date | null;
  outcome: string | null;
  resolution_action_id: string | null;
}

async function appealState(appealId: string): Promise<AppealState> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<AppealState>(`SELECT resolved_at, outcome, resolution_action_id FROM appeals WHERE id = $1`, [appealId]);
    return rows[0]!;
  });
}

/** Every appeal_* log row this appeal produced (resolveAppeal's internal note names it). */
async function appealLogRows(appealId: string): Promise<Array<Record<string, unknown>>> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<Record<string, unknown>>(
      `SELECT * FROM moderation_actions WHERE action LIKE 'appeal\\_%' AND internal_note LIKE $1 ORDER BY created_at`,
      [`appeal ${appealId} %`],
    );
    return rows;
  });
}

async function restoreRows(postId: string): Promise<Array<{ id: string; actor_admin: string }>> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string; actor_admin: string }>(
      `SELECT id, actor_admin FROM moderation_actions WHERE post_id = $1 AND action = 'content_restore'`,
      [postId],
    );
    return rows;
  });
}

async function userRow(userId: string): Promise<{
  disabled_at: Date | null;
  disabled_reason: string | null;
  suspended_until: Date | null;
  reserved_email_hmac: string | null;
  reserved_email_sha256: string | null;
}> {
  return ctxRun(async (c) => {
    const { rows } = await c.query(
      `SELECT disabled_at, disabled_reason, suspended_until, reserved_email_hmac, reserved_email_sha256 FROM users WHERE id = $1`,
      [userId],
    );
    return rows[0] as never;
  });
}

describe("resolveAppeal — the action kinds", () => {
  it("deny: the appeal is resolved `denied`, an appeal_denied row carries the action's subject ids, and the content stays hidden", async () => {
    const author = await mkUser();
    const postId = await seedPost(author);
    const removeId = await decideOn(postId, "remove");
    const before = await hiddenAt(postId);
    expect(before).not.toBeNull();
    const appealId = await appealOf(author, removeId);

    const out = await ctxRun((c) => resolveAppeal(c, { appealId, grant: false, reason: "stands", actorAdmin: "mod2@example.test" }));
    expect(out.kind).toBe("resolved");

    const rows = await appealLogRows(appealId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["action"]).toBe("appeal_denied");
    expect(rows[0]!["post_id"]).toBe(postId);
    expect(rows[0]!["subject_user_id"]).toBe(author);
    const state = await appealState(appealId);
    expect(state.outcome).toBe("denied");
    expect(state.resolved_at).not.toBeNull();
    expect(state.resolution_action_id).toBe(rows[0]!["id"]);
    // Unchanged: still hidden, at the original timestamp, and no restore row.
    expect((await hiddenAt(postId))?.getTime()).toBe(before!.getTime());
    expect(await restoreRows(postId)).toEqual([]);
  });

  it("grant a content_remove on a post: hidden_at is NULL, a content_restore row AND an appeal_granted row exist, resolution_action_id = the appeal_granted row", async () => {
    const author = await mkUser();
    const postId = await seedPost(author);
    const removeId = await decideOn(postId, "remove");
    const appealId = await appealOf(author, removeId);

    await grant(appealId);

    expect(await hiddenAt(postId)).toBeNull();
    const restores = await restoreRows(postId);
    expect(restores).toHaveLength(1);
    expect(restores[0]!.actor_admin).toBe("mod2@example.test");
    const rows = await appealLogRows(appealId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["action"]).toBe("appeal_granted");
    const state = await appealState(appealId);
    expect(state.outcome).toBe("granted");
    expect(state.resolution_action_id).toBe(rows[0]!["id"]);
  });

  it("grant a user_warn: no state change; an appeal_granted row", async () => {
    const u = await mkUser();
    const warnId = await accountAction(u, "warn");
    const before = await userRow(u);
    const appealId = await appealOf(u, warnId);

    await grant(appealId);

    expect(await userRow(u)).toEqual(before);
    const rows = await appealLogRows(appealId);
    expect(rows.map((r) => r["action"])).toEqual(["appeal_granted"]);
    expect(rows[0]!["subject_user_id"]).toBe(u);
  });

  it("grant a user_ban: disabled_at and disabled_reason are NULL", async () => {
    const u = await mkUser();
    const banId = await accountAction(u, "ban");
    expect((await userRow(u)).disabled_reason).toBe("ban"); // control
    await grant(await appealOf(u, banId));
    const row = await userRow(u);
    expect(row.disabled_at).toBeNull();
    expect(row.disabled_reason).toBeNull();
  });

  it("⚠️ Review Focus 5: a ban's appeal on an account since TERMINATED → { kind: 'terminated' }; state untouched, appeal still open", async () => {
    const u = await mkUser();
    const banId = await accountAction(u, "ban");
    const appealId = await appealOf(u, banId);
    await accountAction(u, "terminate");
    const before = await userRow(u);
    expect(before.disabled_reason).toBe("terminate");

    const out = await ctxRun((c) => resolveAppeal(c, { appealId, grant: true, reason: "upheld", actorAdmin: "mod2@example.test" }));

    expect(out).toEqual({ kind: "terminated" });
    expect(await userRow(u)).toEqual(before);
    expect(await appealState(appealId)).toEqual({ resolved_at: null, outcome: null, resolution_action_id: null });
    expect(await appealLogRows(appealId)).toEqual([]);
  });

  it("an already-resolved appeal → { kind: 'already_resolved' }, nothing written", async () => {
    const u = await mkUser();
    const appealId = await appealOf(u, await accountAction(u, "warn"));
    await grant(appealId);
    const stateBefore = await appealState(appealId);

    const again = await ctxRun((c) => resolveAppeal(c, { appealId, grant: false, reason: "again", actorAdmin: "mod3@example.test" }));

    expect(again).toEqual({ kind: "already_resolved" });
    expect(await appealLogRows(appealId)).toHaveLength(1);
    expect(await appealState(appealId)).toEqual(stateBefore);
  });

  it("an unknown appeal id → { kind: 'not_found' }", async () => {
    const out = await ctxRun((c) =>
      resolveAppeal(c, { appealId: crypto.randomUUID(), grant: true, reason: "x", actorAdmin: "mod2@example.test" }),
    );
    expect(out).toEqual({ kind: "not_found" });
  });

  it("⚠️ grant a content_remove whose post has since been DELETED → { kind: 'content_gone' }, no throw, appeal still open, no appeal_granted row", async () => {
    const author = await mkUser();
    const postId = await seedPost(author);
    const appealId = await appealOf(author, await decideOn(postId, "remove"));
    await ctxRun((c) => c.query(`DELETE FROM posts WHERE id = $1`, [postId]));

    const out = await ctxRun((c) => resolveAppeal(c, { appealId, grant: true, reason: "upheld", actorAdmin: "mod2@example.test" }));

    expect(out).toEqual({ kind: "content_gone" });
    expect(await appealState(appealId)).toEqual({ resolved_at: null, outcome: null, resolution_action_id: null });
    expect(await appealLogRows(appealId)).toEqual([]);
    expect(await restoreRows(postId)).toEqual([]);
  });

  it("⚠️ applyDecisionInTx on a missing subject leaves the CALLER's transaction open (no inner ROLLBACK)", async () => {
    const still = await ctxRun(async (c) => {
      await c.query("BEGIN");
      try {
        const { rows: a } = await c.query<{ xid: string }>("SELECT pg_current_xact_id()::text AS xid");
        const result = await applyDecisionInTx(c, {
          subject: "post",
          subjectId: crypto.randomUUID(),
          decision: "restore",
          reason: "r",
          actorAdmin: "mod2@example.test",
        });
        expect(result).toBeNull();
        // Same transaction id ⇔ the caller's transaction was not ended underneath it.
        const { rows: b } = await c.query<{ xid: string | null }>("SELECT pg_current_xact_id_if_assigned()::text AS xid");
        return { before: a[0]!.xid, after: b[0]!.xid };
      } finally {
        try {
          await c.query("ROLLBACK");
        } catch {
          // nothing to keep
        }
      }
    });
    expect(still.after).toBe(still.before);
  });

  it("⚠️ grant a ban on an anonymised, banned account: releases the reserved address (both columns), and signup with it then succeeds (control: 409 before)", async () => {
    const u = await mkUser();
    const email = `${u}@resolve.test`;
    const banId = await accountAction(u, "ban");
    const appealId = await appealOf(u, banId);
    // The real reaper, as barred-reentry.test.ts drives it: a unique far-past
    // deletion request sorts the fixture into the batch.
    await ctxRun((c) =>
      c.query(
        `UPDATE users SET deletion_requested_at = timestamptz '2000-01-01' + (random() * interval '1000 days') WHERE id = $1`,
        [u],
      ),
    );
    await withAnonymiseReaperLock(async () => {
      const ctx = createExecutionContext();
      await anonymiseExpiredAccounts(env, ctx);
      await waitOnExecutionContext(ctx);
    });
    const scrubbed = await userRow(u);
    expect(scrubbed.reserved_email_hmac, "precondition: the reaper reserved the address").not.toBeNull();
    // Control: the address is taken while the ban stands.
    const refused = await signup(email);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("EMAIL_TAKEN");

    await grant(appealId);

    const after = await userRow(u);
    expect(after.disabled_at).toBeNull();
    expect(after.reserved_email_hmac).toBeNull();
    expect(after.reserved_email_sha256).toBeNull();
    const accepted = await signup(email);
    expect(accepted.status).toBe(201);
  });
});

async function signup(email: string): Promise<Response> {
  const handle = `n${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const res = await call("/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: ALLOWED_ORIGIN },
    body: JSON.stringify({ email, password: PASSWORD, username: handle, turnstileToken: "dummy" }),
  });
  if (res.status === 201) {
    await ctxRun(async (c) => {
      const { rows } = await c.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
      for (const r of rows) madeUsers.push(r.id);
    });
  }
  return res;
}

describe("resolveAppeal — ⚠️ the log label (T6): the HANDLE, never the author's email", () => {
  it.each([true, false])("grant=%s on a content_remove: subject_label is the author's current handle; the row never contains the email", async (isGrant) => {
    const author = await mkUser({ handle: true });
    const { email, handle } = await ctxRun(async (c) => {
      const { rows } = await c.query<{ email: string; handle: string }>(
        `SELECT u.email, p.username AS handle FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = $1`,
        [author],
      );
      return rows[0]!;
    });
    const postId = await seedPost(author);
    const removeId = await decideOn(postId, "remove");
    // Control: decide.ts labels the CONTENT action with the email.
    const original = await ctxRun(async (c) => (await c.query(`SELECT subject_label FROM moderation_actions WHERE id = $1`, [removeId])).rows[0]);
    expect(original).toEqual({ subject_label: email });
    const appealId = await appealOf(author, removeId);

    const out = await ctxRun((c) => resolveAppeal(c, { appealId, grant: isGrant, reason: "ruled", actorAdmin: "mod2@example.test" }));
    expect(out.kind).toBe("resolved");

    const rows = await appealLogRows(appealId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["action"]).toBe(isGrant ? "appeal_granted" : "appeal_denied");
    expect(rows[0]!["subject_label"]).toBe(handle);
    expect(JSON.stringify(rows[0])).not.toContain(email);
  });
});

// ---- the Task 4 carry: a granted content appeal closes that decision for for-post ----

describe("⚠️ Task 4 carry — GET /appeals/for-post after a granted content appeal", () => {
  it("keep_hidden → appeal → grant → re-auto-hidden with NO new decision → { target: null }", async () => {
    const actor = await createVerifiedActor();
    const postId = await createPublished(actor);
    const keepId = await decideOn(postId, "keep_hidden");
    const appealId = await appealOf(actor.userId, keepId);
    const forPost = (): Promise<Response> =>
      call(`/appeals/for-post/${postId}`, {
        headers: { Origin: ALLOWED_ORIGIN, Cookie: actor.cookie, "X-CSRF-Token": actor.csrfToken },
      });

    // Control: before the grant, the keep_hidden IS the governing decision.
    const pre = await forPost();
    expect(pre.status).toBe(200);
    expect(((await pre.json()) as { target: { actionId: string } | null }).target?.actionId).toBe(keepId);

    await grant(appealId);
    // Re-hidden (e.g. auto-hide firing again) with no accompanying moderation_actions row.
    await ctxRun((c) => c.query(`UPDATE posts SET hidden_at = now() WHERE id = $1`, [postId]));

    const res = await forPost();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ target: null });
  });
});

// ---- the routes -------------------------------------------------------------------

const b64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (o: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function makeJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = b64urlJson({ iss: `https://${TEAM}`, aud: [AUD], sub: "user-sub-1", email: adminEmail, exp: now + 600 });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://api.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function resolveRoute(
  appealId: string,
  body: unknown,
  opts: { origin?: string; jwt?: boolean } = {},
): Promise<{ response: Response; purges: string[][] }> {
  const purges: string[][] = [];
  const web = {
    fetch: async (_url: string, initArg: RequestInit) => {
      purges.push((JSON.parse(initArg.body as string) as { tags: string[] }).tags);
      return new Response(JSON.stringify({ purged: 1 }), { status: 200 });
    },
  };
  const headers: Record<string, string> = { "content-type": "application/json", Origin: opts.origin ?? ALLOWED_ORIGIN };
  if (opts.jwt !== false) headers["Cf-Access-Jwt-Assertion"] = await makeJwt();
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://api.test/admin/appeals/${appealId}/resolve`, { method: "POST", headers, body: JSON.stringify(body) }),
    { ...env, WEB: web } as never,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { response, purges };
}

const mailsTo = (to: string): Array<Record<string, unknown>> => sentEmails.filter((m) => m["To"] === to);

describe("POST /admin/appeals/:id/resolve", () => {
  it("cross-site origin → 403, before the Access gate; nothing resolved", async () => {
    const u = await mkUser();
    const appealId = await appealOf(u, await accountAction(u, "warn"));
    const { response } = await resolveRoute(appealId, { decision: "grant", reason: "x" }, { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("FORBIDDEN");
    expect((await appealState(appealId)).resolved_at).toBeNull();
  });

  it("no Access JWT → 401; nothing resolved", async () => {
    const u = await mkUser();
    const appealId = await appealOf(u, await accountAction(u, "warn"));
    const { response } = await resolveRoute(appealId, { decision: "grant", reason: "x" }, { jwt: false });
    expect(response.status).toBe(401);
    expect((await appealState(appealId)).resolved_at).toBeNull();
  });

  it("a malformed :id → 404 (never a Postgres 22P02); a blank reason or unknown decision → 400 INVALID_INPUT", async () => {
    expect((await resolveRoute("not-a-uuid", { decision: "grant", reason: "x" })).response.status).toBe(404);
    const u = await mkUser();
    const appealId = await appealOf(u, await accountAction(u, "warn"));
    const blank = (await resolveRoute(appealId, { decision: "grant", reason: "   " })).response;
    expect(blank.status).toBe(400);
    expect(((await blank.json()) as { code: string }).code).toBe("INVALID_INPUT");
    expect((await resolveRoute(appealId, { decision: "maybe", reason: "x" })).response.status).toBe(400);
    expect((await appealState(appealId)).resolved_at).toBeNull();
  });

  it("a content grant: 200, the content is purged, the appellant is mailed the outcome, and the original moderator gets sameReviewer: true (not refused)", async () => {
    const author = await mkUser();
    const postId = await seedPost(author);
    // The SAME moderator took the original action.
    const appealId = await appealOf(author, await decideOn(postId, "remove", adminEmail.toUpperCase()));

    const { response, purges } = await resolveRoute(appealId, { decision: "grant", reason: "  on reflection, fine  " });

    expect(response.status).toBe(200);
    const body = (await response.json()) as AdminAppealResolveResponse;
    expect(body.sameReviewer).toBe(true);
    expect(body.resolutionActionId).toBe((await appealState(appealId)).resolution_action_id);
    expect(await hiddenAt(postId)).toBeNull();
    expect(purges.flat()).toContain(`post:${postId}`);
    const mails = mailsTo(`${author}@resolve.test`);
    expect(mails).toHaveLength(1);
    expect(mails[0]!["Subject"]).toBe("Your appeal was granted");
    expect(String(mails[0]!["TextBody"])).toContain("on reflection, fine");
  });

  it("a deny by a DIFFERENT moderator: 200, sameReviewer: false, no purge, the appellant is mailed 'not granted'", async () => {
    const author = await mkUser();
    const postId = await seedPost(author);
    const appealId = await appealOf(author, await decideOn(postId, "remove"));

    const { response, purges } = await resolveRoute(appealId, { decision: "deny", reason: "it stands" });

    expect(response.status).toBe(200);
    expect(((await response.json()) as AdminAppealResolveResponse).sameReviewer).toBe(false);
    expect(purges).toEqual([]);
    expect(await hiddenAt(postId)).not.toBeNull();
    const mails = mailsTo(`${author}@resolve.test`);
    expect(mails).toHaveLength(1);
    expect(mails[0]!["Subject"]).toBe("Your appeal was not granted");
  });

  it("already resolved → 409 APPEAL_RESOLVED; terminated → 409 NOT_APPEALABLE; content gone → 404", async () => {
    const u = await mkUser();
    const warnAppeal = await appealOf(u, await accountAction(u, "warn"));
    expect((await resolveRoute(warnAppeal, { decision: "deny", reason: "x" })).response.status).toBe(200);
    const again = (await resolveRoute(warnAppeal, { decision: "deny", reason: "x" })).response;
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe("APPEAL_RESOLVED");

    const t = await mkUser();
    const banAppeal = await appealOf(t, await accountAction(t, "ban"));
    await accountAction(t, "terminate");
    const term = (await resolveRoute(banAppeal, { decision: "grant", reason: "x" })).response;
    expect(term.status).toBe(409);
    expect(((await term.json()) as { code: string }).code).toBe("NOT_APPEALABLE");

    const a = await mkUser();
    const postId = await seedPost(a);
    const goneAppeal = await appealOf(a, await decideOn(postId, "remove"));
    await ctxRun((c) => c.query(`DELETE FROM posts WHERE id = $1`, [postId]));
    expect((await resolveRoute(goneAppeal, { decision: "grant", reason: "x" })).response.status).toBe(404);
  });

  it("⚠️ B3: an ANONYMISED appellant: 200, the appeal_granted row exists, and NO email is sent", async () => {
    const u = await mkUser();
    const appealId = await appealOf(u, await accountAction(u, "warn"));
    await ctxRun((c) => c.query(`UPDATE users SET anonymised_at = now() WHERE id = $1`, [u]));

    const { response } = await resolveRoute(appealId, { decision: "grant", reason: "upheld" });

    expect(response.status).toBe(200);
    expect((await appealLogRows(appealId)).map((r) => r["action"])).toEqual(["appeal_granted"]);
    expect(sentEmails).toEqual([]);
  });

  it("⚠️ DSA reporters on a grant: a confirmed open notice is resolved by the content_restore and its reporter mailed the restore lead; an unconfirmed one is not", async () => {
    const author = await mkUser();
    const postId = await seedPost(author);
    const appealId = await appealOf(author, await decideOn(postId, "remove"));
    // Notices that arrived AFTER the removal, so the removal did not resolve them.
    const confirmed = await seedNotice(postId, true);
    const unconfirmed = await seedNotice(postId, false);

    const { response } = await resolveRoute(appealId, { decision: "grant", reason: "no violation after all" });
    expect(response.status).toBe(200);

    const [restore] = await restoreRows(postId);
    expect(restore).toBeDefined();
    const c1 = await noticeRow(confirmed.id);
    expect(c1.resolved_at).not.toBeNull();
    expect(c1.resolution_action_id).toBe(restore!.id);
    const toReporter = mailsTo(confirmed.reporterEmail);
    expect(toReporter).toHaveLength(1);
    expect(String(toReporter[0]!["TextBody"])).toContain("no action was taken");
    // Control: the unconfirmed notice stays inert.
    expect(await noticeRow(unconfirmed.id)).toEqual({ resolved_at: null, resolution_action_id: null });
    expect(mailsTo(unconfirmed.reporterEmail)).toEqual([]);
  });
});

async function seedNotice(postId: string, confirmed: boolean): Promise<{ id: string; reporterEmail: string }> {
  const reporterEmail = `reporter-${crypto.randomUUID()}@example.test`;
  const id = await ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO dsa_notices
         (reporter_email, reporter_name, good_faith, verify_token_hash, target_kind, target_label, post_id, reason, statement, email_verified_at)
       VALUES ($1, 'A Reporter', true, $2, 'post', 'a target label', $3, 'spam', 'This content violates the rules.', ${confirmed ? "now()" : "NULL"})
       RETURNING id`,
      [reporterEmail, `hash-${crypto.randomUUID()}`, postId],
    );
    return rows[0]!.id;
  });
  madeNotices.push(id);
  return { id, reporterEmail };
}

async function noticeRow(id: string): Promise<{ resolved_at: Date | null; resolution_action_id: string | null }> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ resolved_at: Date | null; resolution_action_id: string | null }>(
      `SELECT resolved_at, resolution_action_id FROM dsa_notices WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  });
}

describe("GET /admin/appeals", () => {
  it("lists an open appeal with the appellant's HANDLE (never an email) and the original actor; a resolved one drops off", async () => {
    const u = await mkUser({ handle: true });
    const warnId = await accountAction(u, "warn");
    const appealId = await appealOf(u, warnId);
    const list = async (): Promise<AdminAppealsResponse> => {
      const res = await call("/admin/appeals", { headers: { "Cf-Access-Jwt-Assertion": await makeJwt() } });
      expect(res.status).toBe(200);
      return (await res.json()) as AdminAppealsResponse;
    };

    const open = (await list()).appeals.find((a) => a.id === appealId);
    expect(open).toMatchObject({
      id: appealId,
      body: "please reconsider",
      actionId: warnId,
      action: "user_warn",
      actionReason: "warn reason",
      actionActor: "mod1@example.test",
      appellantHandle: `r${u.replace(/-/g, "").slice(0, 20)}`,
    });
    expect(JSON.stringify(open)).not.toContain("@resolve.test");

    await grant(appealId);
    expect((await list()).appeals.find((a) => a.id === appealId)).toBeUndefined();
  });

  it("no Access JWT → 401", async () => {
    expect((await call("/admin/appeals")).status).toBe(401);
  });
});

// ---- fix round 1 ---------------------------------------------------------------

async function seedComment(authorId: string, postId: string): Promise<string> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `WITH ids AS (SELECT uuidv7() AS id)
       INSERT INTO comments (id, post_id, author_id, parent_id, path, depth, body_markdown)
       SELECT ids.id, $1, $2, NULL, ids.id::text, 0, 'a comment'
         FROM ids
       RETURNING id`,
      [postId, authorId],
    );
    return rows[0]!.id;
  });
}

describe("⚠️ D1 — a stale content appeal never overrides a NEWER decision", () => {
  it("content_remove A → restore → keep_hidden B: granting A's appeal is 409 APPEAL_SUPERSEDED; still hidden, no new restore row, appeal open", async () => {
    const author = await mkUser();
    const postId = await seedPost(author);
    const removeA = await decideOn(postId, "remove");
    const appealId = await appealOf(author, removeA);
    await decideOn(postId, "restore");
    await decideOn(postId, "keep_hidden");
    const hiddenBefore = await hiddenAt(postId);
    expect(hiddenBefore).not.toBeNull();
    const restoresBefore = await restoreRows(postId);
    expect(restoresBefore).toHaveLength(1); // the moderator's own restore

    const { response, purges } = await resolveRoute(appealId, { decision: "grant", reason: "upheld" });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("APPEAL_SUPERSEDED");
    expect((await hiddenAt(postId))?.getTime()).toBe(hiddenBefore!.getTime());
    expect(await restoreRows(postId)).toEqual(restoresBefore);
    expect(await appealState(appealId)).toEqual({ resolved_at: null, outcome: null, resolution_action_id: null });
    expect(await appealLogRows(appealId)).toEqual([]);
    expect(purges).toEqual([]);
    expect(sentEmails).toEqual([]);
  });

  it("resolveAppeal itself answers { kind: 'superseded' }; a DENY of the same superseded appeal is still allowed", async () => {
    const author = await mkUser();
    const postId = await seedPost(author);
    const appealId = await appealOf(author, await decideOn(postId, "remove"));
    await decideOn(postId, "keep_hidden");

    const out = await ctxRun((c) => resolveAppeal(c, { appealId, grant: true, reason: "upheld", actorAdmin: "mod2@example.test" }));
    expect(out).toEqual({ kind: "superseded" });

    const denied = await ctxRun((c) => resolveAppeal(c, { appealId, grant: false, reason: "superseded", actorAdmin: "mod2@example.test" }));
    expect(denied.kind).toBe("resolved");
    expect((await appealState(appealId)).outcome).toBe("denied");
    expect(await hiddenAt(postId)).not.toBeNull();
  });

  it("CONTROL: an OLDER decision on the same post does not supersede (keep_hidden, then remove; appeal the remove → the grant restores)", async () => {
    const author = await mkUser();
    const postId = await seedPost(author);
    await decideOn(postId, "keep_hidden");
    const appealId = await appealOf(author, await decideOn(postId, "remove"));

    await grant(appealId);

    expect(await hiddenAt(postId)).toBeNull();
    expect(await restoreRows(postId)).toHaveLength(1);
  });
});

describe("minor 3 — a grant on a COMMENT's content_remove", () => {
  it("restores the comment, logs against comment_id, and purges the parent post", async () => {
    const author = await mkUser();
    const postId = await seedPost(author);
    const commentId = await seedComment(author, postId);
    const removed = await ctxRun((c) =>
      applyDecision(c, { subject: "comment", subjectId: commentId, decision: "remove", reason: "remove reason", actorAdmin: "mod1@example.test" }),
    );
    const appealId = await appealOf(author, removed!.actionId);

    const { response, purges } = await resolveRoute(appealId, { decision: "grant", reason: "fine after all" });

    expect(response.status).toBe(200);
    const after = await ctxRun(async (c) => {
      const { rows } = await c.query<{ hidden_at: Date | null }>(`SELECT hidden_at FROM comments WHERE id = $1`, [commentId]);
      return rows[0]!.hidden_at;
    });
    expect(after).toBeNull();
    const restores = await ctxRun(async (c) => {
      const { rows } = await c.query(`SELECT post_id, comment_id FROM moderation_actions WHERE comment_id = $1 AND action = 'content_restore'`, [
        commentId,
      ]);
      return rows;
    });
    expect(restores).toEqual([{ post_id: null, comment_id: commentId }]);
    const [logRow] = await appealLogRows(appealId);
    expect(logRow!["comment_id"]).toBe(commentId);
    expect(purges).toEqual([[`post:${postId}`]]);
  });
});

describe("⚠️ D2 — GET /admin/appeals says WHAT is appealed", () => {
  it("a post appeal carries subject 'post' + the post id; an account appeal carries subject 'account' + the user id", async () => {
    const author = await mkUser();
    const postId = await seedPost(author);
    const postAppeal = await appealOf(author, await decideOn(postId, "remove"));
    const u = await mkUser();
    const accountAppeal = await appealOf(u, await accountAction(u, "warn"));

    const res = await call("/admin/appeals", { headers: { "Cf-Access-Jwt-Assertion": await makeJwt() } });
    expect(res.status).toBe(200);
    const { appeals } = (await res.json()) as AdminAppealsResponse;

    expect(appeals.find((a) => a.id === postAppeal)).toMatchObject({ subject: "post", targetId: postId });
    expect(appeals.find((a) => a.id === accountAppeal)).toMatchObject({ subject: "account", targetId: u });
  });
});
