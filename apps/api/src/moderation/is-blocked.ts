/**
 * BLOCK-ENFORCEMENT PREDICATE (design doc
 * docs/superpowers/specs/2026-09-02-m4-report-block-design.md §7): "is ACTOR
 * blocked by TARGET?" — i.e. has the interaction's TARGET (the followee, the
 * post/parent-comment author, the reaction recipient) blocked the ACTOR
 * attempting the interaction. Argument order matters: `targetId` is the
 * potential BLOCKER, `actorId` is the potential BLOCKED party — swapping them
 * at a call site silently inverts who can block whom.
 *
 * ⚠️ Takes the caller's own `Client`, never opens a connection itself. Every
 * call site runs this INSIDE an existing `withClient` block, on the same
 * connection already doing the handler's other reads/writes — never a second
 * Hyperdrive connection for one request.
 */
import type { Client } from "pg";

export async function isBlockedBy(c: Client, targetId: string, actorId: string): Promise<boolean> {
  const { rows } = await c.query<{ blocked: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2) AS blocked`,
    [targetId, actorId],
  );
  return rows[0]?.blocked ?? false;
}
