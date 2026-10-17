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

/**
 * The line every moderation notice carries (notice outbox design, F4: "They
 * should always have the option to email us at dispute@thinkersjournal.com
 * whether they have a token or not."). Appended to the text AND html body of
 * the notice whether or not it also holds an appeal link. Plain text with no
 * HTML-special character, so the html body can pass it through `escapeHtml`
 * and get it back unchanged.
 */
export const DISPUTE_CONTACT_LINE = `You can always dispute this by emailing ${DISPUTE_EMAIL}, whether or not this message includes an appeal link.`;

/** General contact: guidelines, privacy rights, trademark complaints, Terms. */
export const CONTACT_EMAIL = "contact@thinkersjournal.com";
