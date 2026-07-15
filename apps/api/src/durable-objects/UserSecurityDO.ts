/**
 * `UserSecurityDO` — a per-user monotonic "security epoch" counter, one
 * Durable Object instance per user (addressed via `getByName(userId)`).
 *
 * A session's `SessionData.securityEpoch` is stamped at login time. On every
 * revocation check (Tasks 16-17), the request handler compares that stamp
 * against the *current* epoch from this DO: if they differ, the session was
 * issued before the last `bumpEpoch()` call and is treated as revoked. This
 * lets "log out everywhere" / "force re-auth after password change" revoke
 * every outstanding session for a user in O(1) — no need to enumerate or
 * delete individual session records.
 *
 * Backed by the DO's SQLite storage (`new_sqlite_classes` — see
 * `wrangler.jsonc`), NOT in-memory state, so the epoch survives eviction,
 * hibernation, and redeploys.
 */
import { DurableObject } from "cloudflare:workers";

interface SecurityRow extends Record<string, string | number | null> {
  epoch: number;
}

export class UserSecurityDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Runs before any request this instance handles, and only once per
    // instance lifetime — safe to call unconditionally on every construction
    // because both the CREATE TABLE and the seed INSERT are idempotent.
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS security (
           id INTEGER PRIMARY KEY,
           epoch INTEGER NOT NULL DEFAULT 0
         )`,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO security (id, epoch) VALUES (1, 0)
         ON CONFLICT(id) DO NOTHING`,
      );
    });
  }

  /** The current security epoch for this user (starts at 0). */
  async getEpoch(): Promise<number> {
    const row = this.ctx.storage.sql
      .exec<SecurityRow>("SELECT epoch FROM security WHERE id = 1")
      .one();
    return Number(row.epoch);
  }

  /**
   * Atomically increments the epoch and returns the new value. Strictly
   * monotonic: each call increments by exactly 1.
   */
  async bumpEpoch(): Promise<number> {
    const row = this.ctx.storage.sql
      .exec<SecurityRow>(
        "UPDATE security SET epoch = epoch + 1 WHERE id = 1 RETURNING epoch",
      )
      .one();
    return Number(row.epoch);
  }
}
