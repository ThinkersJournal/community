/**
 * Wire types + the one cross-Worker constant for the Cloudflare Access-gated
 * admin surface (M4 2b). A DIFFERENT trust domain from member sessions —
 * see apps/api/src/admin/require-admin.ts and admin/access-jwt.ts.
 */

/**
 * The header Cloudflare Access injects on a request that passed the edge
 * check, and the ONLY thing `requireAdmin` (apps/api/src/admin/require-admin.ts)
 * accepts as proof of admin identity. Shared here so the `web` Worker's
 * admin pages (which forward this header verbatim, never a Worker-held
 * credential) and the `api` Worker's gate read the identical literal —
 * this is the ONE name, not two copies that could drift.
 */
export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

/** `GET /admin/whoami` — the calling admin's own identity. */
export interface AdminIdentityWire {
  email: string;
  sub: string;
}

/** A row in `GET /admin/queue` — mirrors apps/api/src/moderation/queue.ts's
 * `QueueItem`, with `Date`s as ISO strings (the shape after a JSON round-trip). */
export interface AdminQueueItem {
  kind: "post" | "comment";
  targetId: string;
  excerpt: string;
  hiddenAt: string | null;
  reportCount: number;
  severityRank: number;
  oldestReportAt: string;
}

export interface AdminQueueResponse {
  items: AdminQueueItem[];
}

/** Mirrors `DECISIONS` in apps/api/src/routes/admin.ts. */
export const ADMIN_DECISIONS = ["restore", "keep_hidden", "remove"] as const;
export type AdminDecisionKind = (typeof ADMIN_DECISIONS)[number];

/** Mirrors `LEGAL_HOLD_CATEGORIES` in apps/api/src/routes/admin.ts. */
export const LEGAL_HOLD_CATEGORIES = ["csam", "dmca", "other"] as const;
export type LegalHoldCategoryWire = (typeof LEGAL_HOLD_CATEGORIES)[number];

/**
 * A row in `GET /admin/media-access-requests` — the two-person grant queue
 * (#61). `sha256` is derived from `r2_key` for DISPLAY ONLY; the two-person
 * check itself compares `requestedBy`/the viewer's own identity, never this.
 */
export interface AdminMediaAccessRequest {
  id: string;
  sha256: string;
  requestedBy: string;
  reason: string;
  createdAt: string;
}

export interface AdminMediaAccessRequestsResponse {
  requests: AdminMediaAccessRequest[];
}
