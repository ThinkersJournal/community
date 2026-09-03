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
