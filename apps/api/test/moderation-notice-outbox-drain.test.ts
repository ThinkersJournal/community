// SPDX-License-Identifier: MIT OR Apache-2.0
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { withClient } from "../src/db/client";
import {
  LINK_REMOVED_MARKER,
  NOTICE_BACKOFF_MS,
  NOTICE_OUTBOX_BATCH,
  drainNoticeOutbox,
  noticeRetryDelayMs,
  purgeExpiredNoticeOutbox,
  stripLiveLinks,
  type DrainCounts,
} from "../src/moderation/notice-outbox";

import type { Client } from "pg";

/**
 * Notice outbox PR 1 — the drain and the purge. Runs in the POOL project
 * against the real Hyperdrive/Postgres binding; Postmark is a stubbed fetch.
 *
 * ⚠️ Every drain here is SCOPED to the rows this test created
 * (`onlyActionIds`): the test database is shared with other files running in
 * parallel, and an unscoped drain would send their rows.
 * `moderation_notice_outbox` has no foreign keys, so rows are deleted by id in
 * afterEach.
 */

const TOKEN = "Zm9vYmFyX0JBWi0xMjM_QUJD";
const TOKEN_URL = `https://community.thinkersjournal.com/appeal?token=${TOKEN}`;

let sent: Array<Record<string, unknown>> = [];
let postmark: () => Response | Promise<Response>;
let errorSpy: MockInstance;
let logSpy: MockInstance;
let warnSpy: MockInstance;
const userIds: string[] = [];
const outboxIds: string[] = [];
const actionIds: string[] = [];

function okResponse(): Response {
  return new Response(JSON.stringify({ ErrorCode: 0, Message: "OK", MessageID: "test" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function run<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

async function seedUser(anonymised = false): Promise<{ id: string; email: string }> {
  return run(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, email_verified_at) VALUES ($1, 'x', now()) RETURNING id`,
      [`outbox-${crypto.randomUUID()}@example.com`],
    );
    const id = rows[0]!.id;
    userIds.push(id);
    let email = (await c.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [id])).rows[0]!.email;
    if (anonymised) {
      email = `deleted-${id}@invalid.thinkersjournal.local`;
      await c.query(`UPDATE users SET email = $2, anonymised_at = now() WHERE id = $1`, [id, email]);
    }
    return { id, email };
  });
}

interface SeedOptions {
  readonly userId: string | null;
  readonly state?: "pending" | "sending";
  readonly attempts?: number;
  /** Seconds from now (negative = already due). */
  readonly nextInSecs?: number;
  /** Seconds from now, or null for no lease. */
  readonly leasedInSecs?: number | null;
  readonly retainDays?: number;
  readonly marker?: string;
}

function bodies(marker: string): { text: string; html: string } {
  return {
    text: `We removed your content.\n${marker}\nYou can appeal this decision within 30 days: ${TOKEN_URL}\nYou can always dispute this.`,
    html: `<p>We removed your content.</p><p>${marker}</p><p>You can appeal this decision within 30 days: <a href="${TOKEN_URL}">${TOKEN_URL}</a></p><p>You can always dispute this.</p>`,
  };
}

async function seedRow(o: SeedOptions): Promise<{ id: string; actionId: string; marker: string }> {
  const actionId = crypto.randomUUID();
  const marker = o.marker ?? `SECRET-REASON-${crypto.randomUUID()}`;
  const b = bodies(marker);
  const id = await run(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO moderation_notice_outbox
              (action_id, kind, recipient_user_id, subject, body_text, body_html, state, attempts,
               next_attempt_at, leased_until, leased_by, retain_until)
       VALUES ($1, 'author_decision', $2, 'SUBJECT-LINE', $3, $4, $5::text, $6,
               now() + make_interval(secs => $7::double precision),
               CASE WHEN $8::double precision IS NULL THEN NULL ELSE now() + make_interval(secs => $8::double precision) END,
               CASE WHEN $5::text = 'sending' THEN 'dead-pass' ELSE NULL END,
               now() + make_interval(days => $9::int))
       RETURNING id`,
      [
        actionId, o.userId, b.text, b.html, o.state ?? "pending", o.attempts ?? 0,
        o.nextInSecs ?? -5, o.leasedInSecs ?? null, o.retainDays ?? 365,
      ],
    );
    return rows[0]!.id;
  });
  outboxIds.push(id);
  actionIds.push(actionId);
  return { id, actionId, marker };
}

interface RowState {
  state: string; attempts: number; delivered_at: Date | null; last_error: string | null;
  body_text: string; body_html: string; leased_by: string | null; leased_until: Date | null;
  recipient_email: string | null; next_in_ms: number;
}

async function readRow(id: string): Promise<RowState | undefined> {
  return run(async (c) => {
    const { rows } = await c.query<RowState>(
      `SELECT state, attempts, delivered_at, last_error, body_text, body_html, leased_by, leased_until,
              recipient_email, (EXTRACT(EPOCH FROM (next_attempt_at - now())) * 1000)::float8 AS next_in_ms
         FROM moderation_notice_outbox WHERE id = $1`,
      [id],
    );
    return rows[0];
  });
}

async function drain(): Promise<DrainCounts> {
  const ctx = createExecutionContext();
  const counts = await drainNoticeOutbox(env, ctx, { onlyActionIds: [...actionIds] });
  await waitOnExecutionContext(ctx);
  return counts;
}

beforeEach(() => {
  sent = [];
  postmark = okResponse;
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== "https://api.postmarkapp.com/email") throw new Error("unexpected fetch");
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return postmark();
    }),
  );
});

afterEach(async () => {
  if (outboxIds.length > 0 || userIds.length > 0) {
    await run(async (c) => {
      await c.query(`DELETE FROM moderation_notice_outbox WHERE id = ANY($1::uuid[])`, [outboxIds]);
      await c.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
    });
  }
  outboxIds.length = 0;
  userIds.length = 0;
  actionIds.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("drainNoticeOutbox — delivery", () => {
  it("sends a due pending row, stamps delivered_at, and removes the live link from the stored copy (the mailed copy keeps it)", async () => {
    const user = await seedUser();
    const row = await seedRow({ userId: user.id });

    const counts = await drain();

    expect(counts).toMatchObject({ leased: 1, delivered: 1, retried: 0, undeliverable: 0, lost: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ To: user.email, From: "noreply@thinkersjournal.com", Subject: "SUBJECT-LINE", MessageStream: "outbound" });
    // What the member received still has the working link...
    expect(String(sent[0]!["TextBody"])).toContain(TOKEN_URL);
    expect(String(sent[0]!["HtmlBody"])).toContain(`href="${TOKEN_URL}"`);

    // ...and the retained record does not.
    const after = (await readRow(row.id))!;
    expect(after.state).toBe("delivered");
    expect(after.delivered_at).not.toBeNull();
    expect(after.leased_by).toBeNull();
    expect(after.leased_until).toBeNull();
    expect(after.last_error).toBeNull();
    expect(after.body_text).toContain(LINK_REMOVED_MARKER);
    expect(after.body_html).toContain(LINK_REMOVED_MARKER);
    for (const stored of [after.body_text, after.body_html]) {
      expect(stored).not.toContain(TOKEN);
      expect(stored).not.toMatch(/token=/);
      expect(stored).toContain(row.marker); // the rest of the record is intact
    }
    expect(after.body_html).not.toContain("<a href");
  });

  it("counts an expired lease as a failed attempt, and finishes a row whose final attempt expired", async () => {
    const user = await seedUser();
    const retried = await seedRow({ userId: user.id, state: "sending", attempts: 2, leasedInSecs: -60 });
    const finished = await seedRow({ userId: user.id, state: "sending", attempts: 6, leasedInSecs: -60 });

    await drain();

    const a = await readRow(retried.id);
    expect(a?.state).toBe("delivered");
    expect(sent).toHaveLength(1); // the exhausted row was never sent
    const b = await readRow(finished.id);
    expect(b?.state).toBe("undeliverable");
    expect(b?.last_error).toBe("retries_exhausted:lease_expired");
  });

  it("re-reads the address from users at send time (an address changed after the decision is honoured)", async () => {
    const user = await seedUser();
    await seedRow({ userId: user.id });
    const changed = `changed-${crypto.randomUUID()}@example.com`;
    await run((c) => c.query(`UPDATE users SET email = $2 WHERE id = $1`, [user.id, changed]));

    await drain();

    expect(sent).toHaveLength(1);
    expect(sent[0]!["To"]).toBe(changed);
  });

  it("does not send a pending row that is not due yet, nor a row whose lease is still live", async () => {
    const a = await seedUser();
    const b = await seedUser();
    const notDue = await seedRow({ userId: a.id, nextInSecs: 3600 });
    const liveLease = await seedRow({ userId: b.id, state: "sending", leasedInSecs: 300 });
    // CONTROL: a due row in the same drain IS sent, so the two zeros above are about those rows.
    const c = await seedUser();
    await seedRow({ userId: c.id });

    const counts = await drain();

    expect(counts).toMatchObject({ leased: 1, delivered: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!["To"]).toBe(c.email);
    expect((await readRow(notDue.id))!.state).toBe("pending");
    expect((await readRow(liveLease.id))!).toMatchObject({ state: "sending", leased_by: "dead-pass" });
  });

  it("re-leases a row whose lease EXPIRED (a pass that died mid-send)", async () => {
    const user = await seedUser();
    const row = await seedRow({ userId: user.id, state: "sending", leasedInSecs: -60 });

    const counts = await drain();

    expect(counts).toMatchObject({ leased: 1, delivered: 1 });
    expect(sent).toHaveLength(1);
    expect((await readRow(row.id))!).toMatchObject({ state: "delivered", leased_by: null });
  });

  it("leases at most NOTICE_OUTBOX_BATCH rows per pass", async () => {
    const user = await seedUser();
    for (let i = 0; i < NOTICE_OUTBOX_BATCH + 2; i++) await seedRow({ userId: user.id });

    const counts = await drain();

    expect(counts.leased).toBe(NOTICE_OUTBOX_BATCH);
    expect(sent).toHaveLength(NOTICE_OUTBOX_BATCH);
  });
});

describe("drainNoticeOutbox — failures", () => {
  it.each([
    [0, 120_000],
    [1, 600_000],
    [2, 3_600_000],
    [3, 21_600_000],
    [4, 86_400_000],
    [5, 86_400_000],
  ])("a retryable failure on a row with %i prior failures: attempts+1 and the next try per the backoff schedule (%i ms)", async (prior, delayMs) => {
    postmark = () => new Response("Internal Server Error", { status: 500 });
    const user = await seedUser();
    const row = await seedRow({ userId: user.id, attempts: prior });

    const counts = await drain();

    expect(counts).toMatchObject({ leased: 1, retried: 1, delivered: 0, undeliverable: 0 });
    const after = (await readRow(row.id))!;
    expect(after).toMatchObject({ state: "pending", attempts: prior + 1, last_error: "http_500", delivered_at: null, leased_by: null });
    // next_in_ms is measured a moment AFTER the update set it to now() + delay.
    expect(after.next_in_ms).toBeLessThanOrEqual(delayMs);
    expect(after.next_in_ms).toBeGreaterThan(delayMs - 60_000);
    // A failed send keeps the live link in the stored copy: it has not been delivered.
    expect(after.body_text).toContain(TOKEN);
  });

  it("the 7th failure is final: undeliverable, and the reason is a class", async () => {
    postmark = () => new Response("Internal Server Error", { status: 500 });
    const user = await seedUser();
    const row = await seedRow({ userId: user.id, attempts: 6 });

    const counts = await drain();

    expect(counts).toMatchObject({ leased: 1, undeliverable: 1, retried: 0 });
    expect((await readRow(row.id))!).toMatchObject({
      state: "undeliverable", attempts: 7, last_error: "retries_exhausted:http_500", delivered_at: null, leased_by: null,
    });
  });

  it("a transport failure (fetch throws) is retryable, classed 'transport'", async () => {
    postmark = () => {
      throw new Error("network down");
    };
    const user = await seedUser();
    const row = await seedRow({ userId: user.id });

    await drain();

    expect((await readRow(row.id))!).toMatchObject({ state: "pending", attempts: 1, last_error: "transport" });
  });

  it.each([406, 300])("Postmark ErrorCode %i (a permanent recipient refusal) is undeliverable at once", async (code) => {
    postmark = () => jsonResponse(422, { ErrorCode: code, Message: "recipient refused" });
    const user = await seedUser();
    const row = await seedRow({ userId: user.id });

    const counts = await drain();

    expect(counts).toMatchObject({ leased: 1, undeliverable: 1, retried: 0 });
    expect(sent).toHaveLength(1); // one attempt, no retry
    expect((await readRow(row.id))!).toMatchObject({ state: "undeliverable", attempts: 1, last_error: "recipient_refused", leased_by: null });
  });

  it("an account-level Postmark error (ErrorCode 10) is NOT permanent for the notice: it retries", async () => {
    postmark = () => jsonResponse(401, { ErrorCode: 10, Message: "bad token" });
    const user = await seedUser();
    const row = await seedRow({ userId: user.id });

    await drain();

    expect((await readRow(row.id))!).toMatchObject({ state: "pending", attempts: 1, last_error: "postmark_10" });
  });

  it("an anonymised recipient and a vanished one are undeliverable with ZERO sends, while a live recipient in the same batch is sent", async () => {
    const anon = await seedUser(true);
    const gone = crypto.randomUUID();
    const live = await seedUser();
    const rowAnon = await seedRow({ userId: anon.id });
    const rowGone = await seedRow({ userId: gone });
    await seedRow({ userId: live.id });

    const counts = await drain();

    expect(counts).toMatchObject({ leased: 3, delivered: 1, undeliverable: 2 });
    // CONTROL: exactly one send happened, to the live recipient, so "no send" for
    // the other two is not an artefact of a broken stub.
    expect(sent).toHaveLength(1);
    expect(sent[0]!["To"]).toBe(live.email);
    expect(JSON.stringify(sent)).not.toContain("invalid.thinkersjournal.local");
    expect((await readRow(rowAnon.id))!).toMatchObject({ state: "undeliverable", attempts: 0, last_error: "recipient_anonymised", leased_by: null });
    expect((await readRow(rowGone.id))!).toMatchObject({ state: "undeliverable", attempts: 0, last_error: "recipient_gone", leased_by: null });
  });
});

describe("drainNoticeOutbox — logs", () => {
  it("log lines carry counts and classes only: no address, subject, body, reason or token", async () => {
    const delivered = await seedUser();
    const failing = await seedUser();
    const anon = await seedUser(true);
    const rows = [
      await seedRow({ userId: delivered.id }),
      await seedRow({ userId: failing.id }),
      await seedRow({ userId: anon.id }),
    ];
    // Route by the recipient: the failing user's send gets a 500, the others succeed.
    postmark = () => (sent[sent.length - 1]!["To"] === failing.email ? new Response("nope", { status: 500 }) : okResponse());

    const counts = await drain();
    expect(counts).toMatchObject({ leased: 3, delivered: 1, retried: 1, undeliverable: 1 });

    const everything = JSON.stringify([...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]);
    // CONTROL: the drain did log (its counts line), so the absences below are not an empty log.
    expect(logSpy.mock.calls.some((a) => a[0] === "moderation notice outbox drain")).toBe(true);
    for (const forbidden of [delivered.email, failing.email, anon.email, "SUBJECT-LINE", TOKEN, "We removed your content", ...rows.map((r) => r.marker), ...userIds]) {
      expect(everything, forbidden).not.toContain(forbidden);
    }
  });

  it("never throws out of the cron callback, even when the database is unusable", async () => {
    // No network involved: reading the connection string throws.
    const unreachable = {
      get connectionString(): string {
        throw new Error("database unreachable");
      },
    };
    const broken = { ...env, HYPERDRIVE_FRESH: unreachable } as unknown as Env;
    const ctx = createExecutionContext();
    await expect(drainNoticeOutbox(broken, ctx)).resolves.toMatchObject({ leased: 0 });
    await waitOnExecutionContext(ctx);
    // CONTROL: the failure path really ran, and logged a class, not the message.
    expect(errorSpy.mock.calls.filter((a) => a[0] === "moderation notice outbox drain failed")).toEqual([
      ["moderation notice outbox drain failed", { error: "Error" }],
    ]);
  });
});

describe("stripLiveLinks and the backoff schedule (pure)", () => {
  it("replaces the appeal URL in a text body", () => {
    const out = stripLiveLinks(`before ${TOKEN_URL}\nafter`);
    expect(out).toBe(`before ${LINK_REMOVED_MARKER}\nafter`);
  });

  it("replaces the whole anchor in an html body, href and text alike", () => {
    const out = stripLiveLinks(`<p>x <a href="${TOKEN_URL}">${TOKEN_URL}</a> y</p>`);
    expect(out).toBe(`<p>x ${LINK_REMOVED_MARKER} y</p>`);
  });

  it("also removes a delete-request link and several links in one body", () => {
    const del = "https://community.thinkersjournal.com/account/delete-request?token=abc-DEF_123";
    const out = stripLiveLinks(`one ${TOKEN_URL} two ${del} three ${TOKEN_URL}`);
    expect(out).not.toMatch(/token=/);
    expect(out.split(LINK_REMOVED_MARKER)).toHaveLength(4);
  });

  it("leaves a body with no link untouched", () => {
    const body = "No link here. You can always dispute this at dispute@thinkersjournal.com.";
    expect(stripLiveLinks(body)).toBe(body);
  });

  it("the schedule is 2 m, 10 m, 1 h, 6 h, 24 h, 24 h, then final", () => {
    expect([1, 2, 3, 4, 5, 6].map(noticeRetryDelayMs)).toEqual([120_000, 600_000, 3_600_000, 21_600_000, 86_400_000, 86_400_000]);
    expect(NOTICE_BACKOFF_MS).toHaveLength(6);
    expect(noticeRetryDelayMs(7)).toBeNull();
    expect(noticeRetryDelayMs(0)).toBeNull();
  });
});

describe("purgeExpiredNoticeOutbox", () => {
  it("deletes only rows past retain_until, whatever their state", async () => {
    const user = await seedUser();
    const expiredPending = await seedRow({ userId: user.id, retainDays: -1 });
    const expiredSending = await seedRow({ userId: user.id, retainDays: -1, state: "sending", leasedInSecs: 300 });
    const future = await seedRow({ userId: user.id, retainDays: 1 });

    const ctx = createExecutionContext();
    const n = await purgeExpiredNoticeOutbox(env, ctx);
    await waitOnExecutionContext(ctx);

    expect(n).toBeGreaterThanOrEqual(2);
    expect(await readRow(expiredPending.id)).toBeUndefined();
    expect(await readRow(expiredSending.id)).toBeUndefined();
    expect(await readRow(future.id)).toBeDefined();
  });

  // The "30 3 * * *" dispatch is pinned as source in route-protection.test.ts: running the whole
  // nightly tick here would reap other test files' fixtures in the shared test database.
});
