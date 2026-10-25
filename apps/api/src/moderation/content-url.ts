// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Parse the exact URL of a post (`https://<our origin>/@<handle>/<slug>`) into
 * its handle and slug, for a DSA notice filed without a per-item link.
 *
 * Pure string -> value, so it is pinned without a Worker. Anything that is not
 * provably a post on OUR origin returns `null`: another origin, a lookalike
 * host, a non-https scheme, an unparseable string, or a path that is not
 * exactly `/@handle/slug`. The query string and fragment are ignored (a shared
 * link often carries tracking parameters; neither addresses content).
 */
import { CANONICAL_ORIGIN } from "../auth/email-verify";

export function parsePostUrl(raw: string): { username: string; slug: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.origin !== CANONICAL_ORIGIN) return null;

  const m = /^\/@([^/]+)\/([^/]+)\/?$/.exec(url.pathname);
  if (m === null) return null;
  try {
    return { username: decodeURIComponent(m[1]!), slug: decodeURIComponent(m[2]!) };
  } catch {
    return null;
  }
}
