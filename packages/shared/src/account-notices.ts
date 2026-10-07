/**
 * Account-holder notices (security-alerting spec §4). PR 1 ships only the
 * Postmark outcome and its classification; PR 2 adds the rest of §4.1–§4.2.
 */
/** What `postmarkSend` saw, before it collapses to a boolean (§4.4). */
export type PostmarkOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number | null; readonly errorCode: number | null };

/**
 * Postmark's per-recipient refusals that no retry can fix: 300 (send validation,
 * e.g. an invalid address) and 406 (inactive recipient). Everything else (a
 * thrown request, a timeout, HTTP 429 or 5xx, and account-level codes such as
 * 10, 412 or 1480 that an operator must fix) is transient for this notice.
 */
export function classifyPostmark(o: PostmarkOutcome): "sent" | "permanent" | "transient" {
  if (o.ok) return "sent";
  return o.errorCode === 300 || o.errorCode === 406 ? "permanent" : "transient";
}
