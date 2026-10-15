/**
 * Public contact addresses, in ONE place so a change is one edit. Consumed by
 * apps/api (notice emails) and apps/web. CireSnave 2026-10-14: "All
 * *@thinkersjournal.com is forwarded to my ciresnave@gmail.com by Cloudflare."
 *
 * The docs/legal/*.md files are plain markdown and cannot import this; they
 * carry the same literal addresses, and apps/web/test/contact-docs.test.ts
 * fails if they drift from these constants.
 */

/** Where a member contests an adverse moderation decision. */
export const DISPUTE_EMAIL = "dispute@thinkersjournal.com";

/** General contact: guidelines, privacy rights, trademark complaints, Terms. */
export const CONTACT_EMAIL = "contact@thinkersjournal.com";
