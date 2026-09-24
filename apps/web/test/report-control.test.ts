import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Endpoint/UI audit, 2026-09-24 — the shared Report control (post + comment).
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const CONTROL = stripComments(
  readFileSync(join(__dirname, "..", "src", "scripts", "report-control.ts"), "utf8"),
);
const POST_ISLAND = stripComments(
  readFileSync(join(__dirname, "..", "src", "scripts", "post-report.ts"), "utf8"),
);
const COMMENTS_ISLAND = stripComments(
  readFileSync(join(__dirname, "..", "src", "scripts", "comments.ts"), "utf8"),
);
const POST_PAGE = stripComments(
  readFileSync(join(__dirname, "..", "src", "pages", "[handle]", "[slug].astro"), "utf8"),
);

describe("report-control (shared)", () => {
  it("offers all 7 REPORT_REASONS values (mirrors packages/shared/src/moderation.ts's enum)", () => {
    for (const reason of [
      "spam",
      "harassment",
      "hate",
      "sexual",
      "violence",
      "ip_infringement",
      "other",
    ]) {
      expect(CONTROL).toContain(`value: "${reason}"`);
    }
  });

  it("posts to /api/report with the CSRF header", () => {
    expect(CONTROL).toContain('fetch("/api/report"');
    expect(CONTROL).toMatch(/"X-CSRF-Token":\s*opts\.csrfToken/);
  });

  it("⚠️ the success message is the SAME string on every successful submit — never reads response body beyond .ok (PM safety ruling: never reveal threshold/duplicate state)", () => {
    const thenBlock = CONTROL.slice(CONTROL.indexOf(".then((resp)"), CONTROL.indexOf(".catch(() => {\n          note.textContent"));
    expect(thenBlock).toContain("resp.ok");
    expect(thenBlock).not.toMatch(/resp\.json\(|resp\.text\(/);
  });

  it("exports wireReportButton for both callers", () => {
    expect(CONTROL).toContain("export function wireReportButton");
  });
});

describe("post-report island", () => {
  it("reveals only for a signed-in viewer (via /api/me), regardless of ownership — NOT owner-gated like post-delete/post-visibility-view", () => {
    expect(POST_ISLAND).toContain('fetch("/api/me")');
    expect(POST_ISLAND).not.toMatch(/authorId|postAuthorId/);
  });

  it("wires the shared control with a postId target", () => {
    expect(POST_ISLAND).toMatch(/target:\s*\{\s*postId\s*\}/);
  });
});

describe("[handle]/[slug].astro wires the post-report control", () => {
  it("ships a hidden report root carrying the post id", () => {
    expect(POST_PAGE).toMatch(/data-post-report[^>]*hidden|hidden[^>]*data-post-report/);
    expect(POST_PAGE).toContain("data-post-id={post.id}");
  });

  it("guards the root against the .btn[hidden]-class CSS defeat, same as owner-actions/post-delete", () => {
    expect(POST_PAGE).toMatch(/\.post-report\[hidden\]\s*\{\s*display:\s*none/);
  });

  it("mounts initPostReport() alongside the page's other islands", () => {
    expect(POST_PAGE).toContain('import { initPostReport } from "../../scripts/post-report"');
    expect(POST_PAGE).toContain("initPostReport();");
  });
});

describe("comments.ts wires Report onto every comment that is not the viewer's own", () => {
  it("gates on authorId !== viewerId — the one place this control is ownership-gated", () => {
    expect(COMMENTS_ISLAND).toMatch(/authorId !== viewerId\) \{\s*wireReportButton\(actions/);
  });

  it("passes a commentId target", () => {
    expect(COMMENTS_ISLAND).toMatch(/target:\s*\{\s*commentId\s*\}/);
  });
});
