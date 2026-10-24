// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Mint the per-purpose links for one action's notice (#113 plan B). Called by
 * the notice outbox INSIDE the action's transaction (notice-enqueue.ts).
 *
 * A link is omitted when its mint returns null: the account was anonymised
 * (B3), so there is no one to send it to. Whether a notice is sent AT ALL is
 * the caller's business, not this function's — admin.ts skips both the mint
 * and the send when the decision reports `noticeSkip` (#138, #135); this only
 * ever controls whether that notice's link is present.
 */
import type { Client } from "pg";

import { mintActionToken } from "./action-tokens";

import { APPEAL_WINDOW_DAYS, NOTICE_UNDELIVERABLE_HORIZON_DAYS } from "@thinkersjournal/shared";

const DAY_MS = 24 * 3600_000;

/**
 * How long a freshly minted notice link lives (outbox design, section 5): the
 * undeliverable horizon plus the window. The window itself starts at DELIVERY and
 * is enforced by `fileAppeal` (appeals.ts) from the outbox row's `delivered_at`;
 * the drain shortens a delivered notice's links to `delivered_at + window`.
 */
const NOTICE_LINK_TTL_MS = (NOTICE_UNDELIVERABLE_HORIZON_DAYS + APPEAL_WINDOW_DAYS) * DAY_MS;

export interface NoticeLinks {
  appealUrl?: string;
  deleteRequestUrl?: string;
}

/**
 * Mint one appeal token and return its URL, or `null` when the mint returned
 * null (anonymised or missing account). The token lives `NOTICE_LINK_TTL_MS`
 * from NOW (the decision): the undeliverable horizon plus the window.
 *
 * Takes the caller's `Client`, so a caller inside a transaction mints inside it
 * (the notice outbox enqueue, notice-enqueue.ts); `noticeLinks` below calls it
 * on a plain connection after the commit.
 */
export async function mintAppealUrl(
  c: Client,
  origin: string,
  input: { readonly actionId: string; readonly userId: string },
): Promise<string | null> {
  const ttlMs = NOTICE_LINK_TTL_MS;
  const appeal = await mintActionToken(c, { actionId: input.actionId, userId: input.userId, purpose: "appeal", ttlMs });
  return appeal === null ? null : `${origin}/appeal?token=${encodeURIComponent(appeal)}`;
}

/**
 * The links of an account-action notice: the appeal link, plus the
 * delete-request link when the action bars the account. Takes the caller's
 * `Client` and the link origin, so the notice outbox mints inside the action's
 * transaction (notice-enqueue.ts).
 */
export async function mintNoticeLinks(
  c: Client,
  origin: string,
  input: { readonly actionId: string; readonly userId: string; readonly bars: boolean },
): Promise<NoticeLinks> {
  const ttlMs = NOTICE_LINK_TTL_MS;
  const out: NoticeLinks = {};
  const appealUrl = await mintAppealUrl(c, origin, { actionId: input.actionId, userId: input.userId });
  if (appealUrl !== null) out.appealUrl = appealUrl;
  if (input.bars) {
    const del = await mintActionToken(c, { actionId: input.actionId, userId: input.userId, purpose: "delete_request", ttlMs });
    if (del !== null) out.deleteRequestUrl = `${origin}/account/delete-request?token=${encodeURIComponent(del)}`;
  }
  return out;
}
