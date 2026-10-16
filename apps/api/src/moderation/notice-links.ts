/**
 * Mint the per-purpose links for one action's notice (#113 plan B). Called by
 * the admin routes AFTER the action has committed, on its own connection.
 *
 * A link is omitted when its mint returns null: the account was anonymised
 * (B3), so there is no one to send it to. Whether a notice is sent AT ALL is
 * the caller's business, not this function's — admin.ts skips both the mint
 * and the send when the decision reports `noticeSkip` (#138, #135); this only
 * ever controls whether that notice's link is present.
 */
import type { Client } from "pg";

import { verificationLinkOrigin } from "../auth/email-verify";
import { mintActionToken } from "./action-tokens";

import { APPEAL_WINDOW_DAYS } from "@thinkersjournal/shared";

const DAY_MS = 24 * 3600_000;

export interface NoticeLinks {
  appealUrl?: string;
  deleteRequestUrl?: string;
}

/**
 * Mint one appeal token and return its URL, or `null` when the mint returned
 * null (anonymised or missing account). The token lives `APPEAL_WINDOW_DAYS`
 * from NOW (the decision), exactly as `noticeLinks` has always minted it.
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
  const ttlMs = APPEAL_WINDOW_DAYS * DAY_MS;
  const appeal = await mintActionToken(c, { actionId: input.actionId, userId: input.userId, purpose: "appeal", ttlMs });
  return appeal === null ? null : `${origin}/appeal?token=${encodeURIComponent(appeal)}`;
}

export async function noticeLinks(
  c: Client,
  request: Request,
  input: { readonly actionId: string; readonly userId: string; readonly bars: boolean },
): Promise<NoticeLinks> {
  const origin = verificationLinkOrigin(request);
  const ttlMs = APPEAL_WINDOW_DAYS * DAY_MS;
  const out: NoticeLinks = {};
  const appealUrl = await mintAppealUrl(c, origin, { actionId: input.actionId, userId: input.userId });
  if (appealUrl !== null) out.appealUrl = appealUrl;
  if (input.bars) {
    const del = await mintActionToken(c, { actionId: input.actionId, userId: input.userId, purpose: "delete_request", ttlMs });
    if (del !== null) out.deleteRequestUrl = `${origin}/account/delete-request?token=${encodeURIComponent(del)}`;
  }
  return out;
}
