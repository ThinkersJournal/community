// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * The reference card (M3, spec docs/superpowers/specs/2026-11-09-m3-connector-contract.md sections 2, 4.3 and 6) as a
 * PURE function from a prepared `RefCard` to an HTML string. No I/O, no fetching: the caller read Postgres and hands the
 * card over (packages/markdown stays offline).
 *
 * ⚠️ EVERYTHING in a card is untrusted text from a third-party page, and the string this returns is injected into the
 * page AFTER the sanitizer (render.ts), so this file is the whole defence for it. Every value goes through `escapeHtml`,
 * and the two URL-bearing values (the link and the image) are additionally parsed and refused unless they are `https:`
 * (the image) or `http(s):` (the link): escaping alone does not stop `javascript:`.
 */

/** Launch writes only `remote`; `stored` (a future R2 copy) is not rendered yet. Mirrors `ImageRef` in packages/shared. */
export type RefCardImage =
  | { storage: "remote"; url: string; alt?: string; width?: number; height?: number }
  | { storage: "stored"; key: string; alt?: string; width: number; height: number };

export interface RefCardStatus {
  label: "changed" | "resolved" | "gone";
  /** ISO timestamp the status was observed; only its date is shown (cached HTML cannot say "5 minutes ago"). */
  asOf?: string;
}

/** What the caller prepares per token. Mirrors `RefCard` in packages/shared (the wire type); kept structural. */
export interface RefCard {
  /** The connector kind ("web", "github", ...); the label when there is no site name. */
  kind: string;
  /** The canonical human URL. Never an API URL. */
  deepLink: string;
  title: string;
  /** The description or excerpt, already capped. Shown as plain text. */
  description?: string;
  siteName?: string;
  image?: RefCardImage;
  status?: RefCardStatus;
}

/** `null` = a known token whose card is unavailable (snapshot removed). An absent token is unknown: renders nothing. */
export type RefMap = ReadonlyMap<string, RefCard | null>;

export const UNAVAILABLE_TEXT = "This link is no longer available";
const STATUS_TEXT: Record<RefCardStatus["label"], string> = {
  changed: "Changed since this was shared",
  resolved: "Resolved since this was shared",
  gone: UNAVAILABLE_TEXT,
};
const LINK_REL = "nofollow ugc noopener";
const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

/** Escape text for an HTML text node or a double-quoted attribute value. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** The normalised URL if `raw` parses and its scheme is allowed; otherwise null. */
function safeUrl(raw: string, schemes: readonly string[]): string | null {
  try {
    const url = new URL(raw);
    return schemes.includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function imageHtml(image: RefCardImage | undefined): string {
  if (image?.storage !== "remote") return "";
  const src = safeUrl(image.url, ["https:"]);
  if (src === null) return "";
  return (
    `<div class="ref-card__media"><img class="ref-card__image" src="${escapeHtml(src)}" alt="${escapeHtml(image.alt ?? "")}" ` +
    `referrerpolicy="no-referrer" loading="lazy" decoding="async"></div>`
  );
}

function titleHtml(card: RefCard): string {
  const href = safeUrl(card.deepLink, ["http:", "https:"]);
  const text = card.title;
  const inner = href === null ? text : `<a href="${escapeHtml(href)}" rel="${LINK_REL}">${text}</a>`;
  return `<p class="ref-card__title">${inner}</p>`;
}

function statusHtml(status: RefCardStatus | undefined): string {
  if (status === undefined) return "";
  const asOf = status.asOf !== undefined && DATE_PREFIX.test(status.asOf) ? status.asOf.slice(0, 10) : null;
  const when = asOf === null ? "" : ` &middot; as of <time datetime="${escapeHtml(asOf)}">${escapeHtml(asOf)}</time>`;
  return `<p class="ref-card__status">${escapeHtml(STATUS_TEXT[status.label])}${when}</p>`;
}

/** The card as an HTML fragment. `null` is the "no longer available" card (the snapshot was removed). */
export function renderRefCard(card: RefCard | null): string {
  if (card === null) {
    return `<div class="ref-card ref-card--unavailable"><p class="ref-card__status">${UNAVAILABLE_TEXT}</p></div>`;
  }
  const gone = card.status?.label === "gone" ? " ref-card--unavailable" : "";
  const site = `<p class="ref-card__site">${escapeHtml(card.siteName ?? card.kind)}</p>`;
  const description = card.description ? `<p class="ref-card__description">${escapeHtml(card.description)}</p>` : "";
  return (
    `<div class="ref-card${gone}" data-ref-kind="${escapeHtml(card.kind)}">${imageHtml(card.image)}` +
    `<div class="ref-card__body">${site}${titleHtml(card)}${description}${statusHtml(card.status)}</div></div>`
  );
}
