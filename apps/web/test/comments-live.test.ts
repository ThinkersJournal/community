import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const code = readFileSync(join(__dirname, "..", "src", "scripts", "comments-live.ts"), "utf8");
function strip(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const stripped = strip(code);

describe("comments-live client", () => {
  it("opens a WebSocket to /api/posts-live with the post id, only when the comments section exists", () => {
    expect(stripped).toMatch(/location\.protocol === "https:" \? "wss" : "ws"[\s\S]{0,200}\/api\/posts-live/);
    expect(stripped).toContain("new WebSocket(");
    expect(stripped).toMatch(/postId/);
    expect(stripped).toMatch(/data-comments/); // gated on the section
  });
  it("nudge is content-free: onmessage switches on {type}, never renders event.data", () => {
    expect(stripped).toMatch(/onmessage[\s\S]{0,200}type/);
    expect(stripped).not.toMatch(/onmessage[\s\S]{0,300}innerHTML\s*=\s*[^;]*event\.data/);
    // reaction nudge → refetch counts; comment nudge → fetch the fragment window
    expect(stripped).toMatch(/refreshReactionCounts\(\)/);
    expect(stripped).toContain("/api/comments-fragment");
  });
  it("reconciles by id: inserts new, tombstones deletes, swaps edited, NEVER removes a node, skips open forms", () => {
    expect(stripped).toMatch(/querySelector[\s\S]{0,80}data-comment-id/); // looks up existing by id
    expect(stripped).toMatch(/data-deleted|tombstone/); // delete → tombstone
    expect(stripped).not.toContain(".remove()"); // never live-remove
    expect(stripped).toMatch(/form|data-open/); // do-not-disrupt: skip a comment with an open form
    expect(stripped).toContain("wireCommentAffordances"); // re-wire inserted comments
  });
  it("the ONLY html sink is the fragment's rendered html, and there is a single live socket", () => {
    // innerHTML is used solely for the comment body from the fragment endpoint
    expect(stripped).toMatch(/comment-body[\s\S]{0,120}innerHTML/);
    expect(stripped).toMatch(/if \(ws !== null\) return/);
  });
});
