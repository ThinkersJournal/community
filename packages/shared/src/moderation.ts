/**
 * The zod input schemas for the report/block WRITES. Mirrors the pattern in
 * engagement-write.ts (one-target refine) and social.ts (single-field uuid
 * input) — see docs/superpowers/specs/2026-09-02-m4-report-block-design.md §4.
 */
import { z } from "zod";

/** Mirrors the `reports_reason_valid` CHECK in migration 0012. */
export const REPORT_REASONS = [
  "spam",
  "harassment",
  "hate",
  "sexual",
  "violence",
  "ip_infringement",
  "other",
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

export const ReportInput = z
  .object({
    postId: z.string().uuid().optional(),
    commentId: z.string().uuid().optional(),
    reason: z.enum(REPORT_REASONS),
  })
  .refine((t) => (t.postId === undefined) !== (t.commentId === undefined), {
    message: "exactly one of postId/commentId",
  });

export const BlockInput = z.object({
  blockedId: z.string().uuid(),
});

/** `GET /blocks/status?id=…&id=…` — the subset of ids the viewer has blocked. */
export interface BlockStatusResult {
  blocked: string[];
  /** The signed-in viewer's own user id (so a caller can self-exclude/hide). */
  viewerId: string;
}

/** A row in the viewer's own blocked-users list. */
export interface BlockedUser {
  userId: string;
  username: string;
  displayName: string | null;
}

/** `GET /blocks` — every user the signed-in viewer has blocked, most recent first. */
export interface BlockedList {
  users: BlockedUser[];
}

/**
 * DSA Art. 16 notice (spec §8). Unauthenticated: the reporter proves a working
 * inbox by confirming. `goodFaith` must be literally true (Art. 16(2)(d)).
 */
export const DsaNoticeInput = z
  .object({
    postId: z.string().uuid().optional(),
    commentId: z.string().uuid().optional(),
    reason: z.enum(REPORT_REASONS),
    statement: z.string().trim().min(1).max(5000),
    reporterName: z.string().trim().min(1).max(200),
    // M6 (final-review fix): cap at 254, the longest address RFC 5321 permits
    // — `z.email()` alone has no length bound. Validations before the
    // `.toLowerCase()` transform, same order as NormalizedEmail in schemas.ts.
    reporterEmail: z.email().max(254).toLowerCase(),
    goodFaith: z.literal(true),
    turnstileToken: z.string().min(1),
  })
  .refine((t) => (t.postId === undefined) !== (t.commentId === undefined), {
    message: "exactly one of postId/commentId",
  });
export type DsaNoticeInputT = z.infer<typeof DsaNoticeInput>;
