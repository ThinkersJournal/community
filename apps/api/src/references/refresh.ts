// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * M3.2c-2: refresh ONE stored reference (spec docs/superpowers/specs/2026-11-09-m3-connector-contract.md section 3,
 * design decision 22). The Queue consumer (next slice) calls this once per message.
 *
 * ⚠️ ACCESS IS NOT DIFF. A rate-limited, errored or forbidden look says nothing about the content: the stored live_state
 * is left alone and only the retry is scheduled (`retryAt`, which backs off and is capped, never a hot loop). A throw
 * from a connector is the same: an unknown outcome. Only a definitive result changes live_state, and only a definitive
 * `gone` sets `gone_at`.
 *
 * WHO PAYS. The per-author budget is charged to the author of the NEWEST use of the reference (latest
 * `post_references.created_at`; a tie goes to the lowest post id, so the answer is stable). A removed use drops out of
 * the query by itself, so the next newest author pays. A reference with no uses at all is an orphan: nobody can be
 * charged and nothing needs it, so it goes dormant (`next_check_at` NULL) for the garbage-collection sweep (2d).
 */
import { ConnectorError, type FetchCtx, type LiveResult, type SourceKind, type StoredReference } from "@thinkersjournal/shared";

import { mergeLive, nextCheckAt, retryAt, type LiveState } from "./refresh-schedule";

import type { SpendResult } from "./author-budget";
import type { Registry } from "./registry";
import type { Client } from "pg";

/** The per-author budget. In production this is `env.AUTHOR_BUDGET.getByName(authorId).take(cost)`. */
export interface RefreshBudget {
  take(authorId: string, cost: number): Promise<SpendResult>;
}

export interface RefreshDeps {
  registry: Registry;
  ctx: FetchCtx;
  budget: RefreshBudget;
  now: Date;
}

export type RefreshOutcome = "missing" | "gone" | "orphan" | "throttled" | "unknown" | "refreshed";

interface Row {
  kind: string;
  resource_key: string;
  snapshot: StoredReference["snapshot"];
  content_hash: string;
  etag: string | null;
  last_modified: string | null;
  live_state: LiveState | null;
  last_viewed_at: Date | null;
  gone_at: Date | null;
  refresh_failures: number;
}

const KINDS: readonly SourceKind[] = ["web", "github", "gitlab"];
const UNKNOWN: LiveResult = { access: "error", diff: "unknown" };

function storedOf(row: Row, kind: SourceKind): StoredReference {
  const prefix = `${kind}:`;
  const canonicalUrl = row.resource_key.startsWith(prefix) ? row.resource_key.slice(prefix.length) : row.resource_key;
  const ref: StoredReference = {
    kind,
    resourceKey: row.resource_key,
    canonicalUrl,
    snapshot: row.snapshot,
    contentHash: row.content_hash,
  };
  if (row.etag !== null) ref.etag = row.etag;
  if (row.last_modified !== null) ref.lastModified = row.last_modified;
  return ref;
}

/** The author of the newest use, or null for an orphan. Newest first; ties to the lowest post id. */
async function payer(db: Client, referenceId: string): Promise<string | null> {
  const { rows } = await db.query<{ author_id: string }>(
    `SELECT p.author_id
       FROM post_references pr JOIN posts p ON p.id = pr.post_id
      WHERE pr.reference_id = $1
      ORDER BY pr.created_at DESC, pr.post_id ASC
      LIMIT 1`,
    [referenceId],
  );
  return rows[0]?.author_id ?? null;
}

async function setNext(db: Client, id: string, next: Date | null, now: Date): Promise<void> {
  await db.query(`UPDATE "references" SET next_check_at = $2, updated_at = $3 WHERE id = $1`, [id, next, now]);
}

/** What the source said, or an unknown outcome if the connector threw (a ConnectorError is expected, anything else is a bug and is logged). */
async function look(row: Row, kind: SourceKind, deps: RefreshDeps, id: string): Promise<LiveResult> {
  const connector = deps.registry.get(kind);
  if (connector === undefined) {
    console.error(`refreshReference ${id}: no connector registered for kind ${kind}`);
    return UNKNOWN;
  }
  try {
    return await connector.fetchLive(storedOf(row, kind), deps.ctx);
  } catch (e) {
    if (!(e instanceof ConnectorError)) console.error(`refreshReference ${id}: connector threw`, e);
    return UNKNOWN;
  }
}

export async function refreshReference(db: Client, referenceId: string, deps: RefreshDeps): Promise<RefreshOutcome> {
  const { now } = deps;
  const { rows } = await db.query<Row>(
    `SELECT kind, resource_key, snapshot, content_hash, etag, last_modified, live_state, last_viewed_at, gone_at, refresh_failures
       FROM "references" WHERE id = $1`,
    [referenceId],
  );
  const row = rows[0];
  if (row === undefined) return "missing";
  if (row.gone_at !== null) return "gone";

  const author = await payer(db, referenceId);
  if (author === null) {
    await setNext(db, referenceId, null, now);
    return "orphan";
  }

  const spent = await deps.budget.take(author, 1);
  if (!spent.ok) {
    const wait = Number.isFinite(spent.retryAfterMs) ? spent.retryAfterMs : null;
    await setNext(db, referenceId, wait === null ? retryAt(now, row.refresh_failures) : new Date(now.getTime() + wait), now);
    return "throttled";
  }

  const kind = KINDS.find((k) => k === row.kind);
  const res = kind === undefined ? UNKNOWN : await look(row, kind, deps, referenceId);

  if (res.diff === "unknown") {
    await db.query(
      `UPDATE "references" SET refresh_failures = refresh_failures + 1, next_check_at = $2, updated_at = $3 WHERE id = $1`,
      [referenceId, retryAt(now, row.refresh_failures), now],
    );
    return "unknown";
  }

  const live = mergeLive(row.live_state, res, now);
  const gone = res.diff === "gone";
  await db.query(
    `UPDATE "references"
        SET live_state = $2, etag = $3, last_modified = $4, gone_at = $5,
            refresh_failures = 0, next_check_at = $6, updated_at = $7
      WHERE id = $1`,
    [
      referenceId,
      live === null ? null : JSON.stringify(live),
      res.etag ?? row.etag,
      res.lastModified ?? row.last_modified,
      gone ? now : null,
      gone ? null : nextCheckAt(now, row.last_viewed_at),
      now,
    ],
  );
  return "refreshed";
}
