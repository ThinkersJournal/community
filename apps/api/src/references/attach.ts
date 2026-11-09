// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * `attachReference`: the server function the M3.4 picker will call (spec 2 and 4.1/4.2). Given a post and a URL it
 * identifies the connector, reuses a fresh stored `"references"` row or resolves the URL once, and stores the use with a
 * fresh token.
 *
 * ⚠️ IT NEVER THROWS AND NEVER LOSES THE POST. A reference is an enhancement. The post is already saved when this is
 * called, and any failure (a blocked target, a timeout, a bad page, a rate limit, our own bug) comes back as a typed
 * `{ ok: false, reason }` for the caller to show fixed copy for; the author's URL then simply stays an ordinary link.
 * An unexpected error is logged (the reason is "internal"), never swallowed.
 *
 * ⚠️ THE NETWORK CALL IS OUTSIDE THE TRANSACTION. `resolve` can take 5 seconds; holding a row lock across it would
 * stall every other writer of the post. The transaction wraps only the writes, and it takes the post row's lock
 * (`FOR UPDATE`) so the 10-reference cap holds under concurrent attaches (a count taken before the lock is only an early
 * out that saves a fetch).
 *
 * LIMITS (values documented here, bindings added by the wiring PR):
 *   - per user: `ATTACH_LIMIT_PER_MINUTE` attaches per minute, through the injected limiter (a Workers rate-limit
 *     binding in production, keyed on the author's id). Conservative: a person adds a handful of cards a minute at most,
 *     and each attach can cost an outbound fetch.
 *   - per post: `MAX_REFERENCES_PER_POST` (10).
 *   - per origin: see origin-limit.ts; it lives in the `ctx.fetch` the caller passes in.
 */
import { ConnectorError, MAX_REFERENCES_PER_POST, type FetchCtx, type Resolved } from "@thinkersjournal/shared";

import { isUniqueViolation } from "../db/errors";
import { OriginRateLimitedError, type LimiterLike } from "./origin-limit";
import { defaultRegistry, type Registry } from "./registry";

import type { Client } from "pg";

/** Suggested per-user limit for the wiring PR's binding. */
export const ATTACH_LIMIT_PER_MINUTE = 10;
/** A stored row younger than this is reused instead of resolving again (spec 4.1: "the type's window"; web: a day). */
export const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

const TOKEN_ATTEMPTS = 5;
const TOKEN_LENGTH = 12;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export type AttachFailure =
  | "invalid_url"
  | "unsupported"
  | "blocked_target"
  | "not_found"
  | "too_large"
  | "timeout"
  | "upstream"
  | "rate_limited"
  | "too_many_references"
  | "post_not_found"
  | "internal";

export type AttachResult = { ok: true; token: string; referenceId: string; reused: boolean } | { ok: false; reason: AttachFailure };

export interface AttachDeps {
  /** The guarded door (optionally wrapped by `withOriginLimit`). Never the global fetch. */
  ctx: FetchCtx;
  /** Per-user attach limiter. Omitted = unlimited (tests); production always passes one. */
  limiter?: LimiterLike;
  registry?: Registry;
  now?: () => Date;
  newToken?: () => string;
}

interface AttachInput {
  postId: string;
  authorId: string;
  url: string;
}

/** 12 characters of unpadded base32 from a CSPRNG, never derived from the URL (spec 2). 256 is a multiple of 32: no bias. */
export function newRefToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_LENGTH));
  return Array.from(bytes, (b) => BASE32.charAt(b & 31)).join("");
}

const fail = (reason: AttachFailure): AttachResult => ({ ok: false, reason });

function reasonOf(e: unknown): AttachFailure {
  if (e instanceof OriginRateLimitedError) return "rate_limited";
  if (e instanceof ConnectorError) return e.code;
  return "internal";
}

async function ownsPost(db: Client, postId: string, authorId: string): Promise<boolean> {
  const { rowCount } = await db.query("SELECT 1 FROM posts WHERE id = $1 AND author_id = $2", [postId, authorId]);
  return rowCount === 1;
}

async function useCount(db: Client, postId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM post_references WHERE post_id = $1", [postId]);
  return rows[0]?.n ?? 0;
}

/** The newest stored row for this key that still has a snapshot and is within the freshness window. */
async function findFresh(db: Client, kind: string, resourceKey: string, now: Date): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM "references"
      WHERE kind = $1 AND resource_key = $2 AND gone_at IS NULL AND snapshot IS NOT NULL AND updated_at > $3
      ORDER BY updated_at DESC LIMIT 1`,
    [kind, resourceKey, new Date(now.getTime() - FRESH_WINDOW_MS)],
  );
  return rows[0]?.id ?? null;
}

/**
 * Insert or refresh the shared row. A re-resolve of identical content lands on the same row (the UNIQUE), changed
 * content gets a new one. ⚠️ An existing snapshot is NEVER refilled: a takedown nulls it in place and that must stick.
 */
async function upsertReference(db: Client, kind: string, resolved: Resolved): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO "references" (kind, resource_key, content_hash, snapshot, etag, last_modified)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (kind, resource_key, content_hash)
     DO UPDATE SET updated_at = now(), etag = EXCLUDED.etag, last_modified = EXCLUDED.last_modified
     RETURNING id`,
    [kind, resolved.resourceKey, resolved.contentHash, JSON.stringify(resolved.snapshot), resolved.etag ?? null, resolved.lastModified ?? null],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("references upsert returned no row");
  return id;
}

/** Insert the use under a fresh token, retrying on a collision. Each attempt is a savepoint: a unique violation aborts the transaction. */
async function insertUse(db: Client, postId: string, referenceId: string, newToken: () => string): Promise<string> {
  for (let attempt = 0; attempt < TOKEN_ATTEMPTS; attempt += 1) {
    const token = newToken();
    await db.query("SAVEPOINT ref_token");
    try {
      await db.query(
        `INSERT INTO post_references (post_id, reference_id, token, position)
         VALUES ($1, $2, $3, (SELECT COALESCE(MAX(position), -1) + 1 FROM post_references WHERE post_id = $1))`,
        [postId, referenceId, token],
      );
      await db.query("RELEASE SAVEPOINT ref_token");
      return token;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      await db.query("ROLLBACK TO SAVEPOINT ref_token");
    }
  }
  throw new Error("no unused token after several attempts");
}

async function rollback(db: Client): Promise<void> {
  try {
    await db.query("ROLLBACK");
  } catch (e) {
    console.error("references: rollback failed", e);
  }
}

/** The writes, in one transaction that holds the post row's lock. `referenceFor` runs inside it. */
async function store(
  db: Client,
  input: AttachInput,
  referenceFor: () => Promise<string>,
  reused: boolean,
  newToken: () => string,
): Promise<AttachResult> {
  await db.query("BEGIN");
  try {
    const locked = await db.query("SELECT 1 FROM posts WHERE id = $1 AND author_id = $2 FOR UPDATE", [input.postId, input.authorId]);
    if (locked.rowCount !== 1) {
      await rollback(db);
      return fail("post_not_found");
    }
    if ((await useCount(db, input.postId)) >= MAX_REFERENCES_PER_POST) {
      await rollback(db);
      return fail("too_many_references");
    }
    const referenceId = await referenceFor();
    const token = await insertUse(db, input.postId, referenceId, newToken);
    await db.query("COMMIT");
    return { ok: true, token, referenceId, reused };
  } catch (e) {
    await rollback(db);
    throw e;
  }
}

async function attach(db: Client, input: AttachInput, deps: AttachDeps): Promise<AttachResult> {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return fail("invalid_url");
  }
  const hit = (deps.registry ?? defaultRegistry).identify(url);
  if (hit === null) return fail("unsupported");
  if (!(await ownsPost(db, input.postId, input.authorId))) return fail("post_not_found");
  if (deps.limiter !== undefined) {
    const { success } = await deps.limiter.limit({ key: `refs-attach:${input.authorId}` });
    if (!success) return fail("rate_limited");
  }
  if ((await useCount(db, input.postId)) >= MAX_REFERENCES_PER_POST) return fail("too_many_references");

  const newToken = deps.newToken ?? newRefToken;
  const now = (deps.now ?? (() => new Date()))();
  const cached = await findFresh(db, hit.id.kind, hit.id.resourceKey, now);
  if (cached !== null) return store(db, input, () => Promise.resolve(cached), true, newToken);
  const resolved = await hit.connector.resolve(hit.id, deps.ctx); // OUTSIDE the transaction
  return store(db, input, () => upsertReference(db, hit.id.kind, resolved), false, newToken);
}

export async function attachReference(db: Client, input: AttachInput, deps: AttachDeps): Promise<AttachResult> {
  try {
    return await attach(db, input, deps);
  } catch (e) {
    const reason = reasonOf(e);
    if (reason === "internal") console.error("references: attach failed unexpectedly", e);
    return fail(reason);
  }
}
