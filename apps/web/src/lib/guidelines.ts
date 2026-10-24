// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * The published Community Guidelines text, read from the repo file at BUILD time
 * (`?raw`), so the page and docs/legal/community-guidelines.md cannot differ.
 *
 * ⚠️ TRUSTED INPUT ONLY. The source is a reviewed repo file, never user input.
 * It still goes through `renderMarkdown` (packages/markdown), the same
 * sanitizing pipeline the post page uses, so raw HTML and `javascript:` URLs
 * cannot reach the page even if someone edits the file carelessly.
 */
import guidelinesMarkdown from "../../../../docs/legal/community-guidelines.md?raw";

/**
 * The markdown without its `# title` line and its `**Version:** ...` stamp line:
 * the page renders both itself (heading + constants), so the stamp shown can
 * never be the file's own copy. apps/web/test/guidelines-markdown.test.ts keeps
 * the file's stamp equal to the constants.
 */
export function guidelinesBody(markdown: string = guidelinesMarkdown): string {
  return markdown
    .split(/\r?\n/)
    .filter((line) => !/^# /.test(line) && !/^\*\*Version:\*\*/.test(line))
    .join("\n")
    .trim();
}
