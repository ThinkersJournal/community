// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * The published Community Guidelines (docs/legal/community-guidelines.md): the
 * version stamp and the public path, in ONE place so the page, the notice
 * emails and the markdown file cannot drift. apps/web/test/guidelines-markdown.test.ts
 * fails when the markdown's "Version ... Effective ..." line differs from these.
 *
 * ⚠️ Change the text of the guidelines => change GUIDELINES_VERSION (and the
 * markdown line) in the same commit. A stored moderation notice records the
 * version that was current when it was sent.
 */
export const GUIDELINES_VERSION = "2026-10-25.2";

/** ISO date (YYYY-MM-DD) the published version took effect. */
export const GUIDELINES_EFFECTIVE_DATE = "2026-10-25";

/** Public path of the page, relative to the community origin. */
export const GUIDELINES_PATH = "/guidelines";
