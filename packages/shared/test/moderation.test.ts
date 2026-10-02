import { describe, expect, it } from "vitest";

import { BlockInput, DsaNoticeInput, ReportInput } from "../src";

describe("ReportInput", () => {
  const reason = "spam" as const;

  it("accepts exactly one target with a valid reason", () => {
    expect(ReportInput.safeParse({ postId: crypto.randomUUID(), reason }).success).toBe(true);
    expect(ReportInput.safeParse({ commentId: crypto.randomUUID(), reason }).success).toBe(true);
  });

  it("rejects zero targets and two targets", () => {
    expect(ReportInput.safeParse({ reason }).success).toBe(false);
    expect(
      ReportInput.safeParse({
        postId: crypto.randomUUID(),
        commentId: crypto.randomUUID(),
        reason,
      }).success,
    ).toBe(false);
  });

  it("rejects an invalid reason", () => {
    expect(
      ReportInput.safeParse({ postId: crypto.randomUUID(), reason: "nonsense" }).success,
    ).toBe(false);
  });

  it("rejects a non-uuid id", () => {
    expect(ReportInput.safeParse({ postId: "nope", reason }).success).toBe(false);
  });
});

/**
 * Builds a syntactically valid address of EXACTLY `totalLen` characters:
 * one-char local part, `@`, then as many 63-char dot-separated labels as fit,
 * a final (possibly short) label, and a `.com` TLD. Used by M6's 254/255
 * boundary test below, where the exact length is the point.
 */
function emailOfLength(totalLen: number): string {
  const local = "a";
  const tld = ".com";
  let remaining = totalLen - local.length - 1 /* @ */ - tld.length;
  const labelLens: number[] = [];
  while (remaining > 63) {
    labelLens.push(63);
    remaining -= 64; // the label plus its separating dot
  }
  labelLens.push(Math.max(1, remaining));
  const domain = labelLens.map((n) => "b".repeat(n)).join(".") + tld;
  const email = `${local}@${domain}`;
  if (email.length !== totalLen) {
    throw new Error(`emailOfLength(${totalLen}) produced length ${email.length}`);
  }
  return email;
}

describe("DsaNoticeInput", () => {
  function validNotice(reporterEmail: string) {
    return {
      postId: crypto.randomUUID(),
      reason: "spam" as const,
      statement: "This content infringes my rights.",
      reporterName: "Jane Reporter",
      reporterEmail,
      goodFaith: true as const,
      turnstileToken: "t",
    };
  }

  it("M6: accepts a 254-character reporterEmail and rejects 255", () => {
    const email254 = emailOfLength(254);
    const email255 = emailOfLength(255);
    expect(email254).toHaveLength(254);
    expect(email255).toHaveLength(255);

    expect(DsaNoticeInput.safeParse(validNotice(email254)).success).toBe(true);
    expect(DsaNoticeInput.safeParse(validNotice(email255)).success).toBe(false);
  });
});

describe("BlockInput", () => {
  it("accepts a uuid blockedId", () => {
    const id = crypto.randomUUID();
    expect(BlockInput.parse({ blockedId: id }).blockedId).toBe(id);
  });

  it("rejects a non-uuid blockedId", () => {
    expect(BlockInput.safeParse({ blockedId: "nope" }).success).toBe(false);
  });
});
