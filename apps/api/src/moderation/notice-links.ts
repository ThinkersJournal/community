/**
 * Mint the per-purpose links for one action's notice (#113 plan B). Called by
 * the admin routes AFTER the action has committed, on its own connection.
 *
 * A link is omitted when its mint returns null: the account was anonymised
 * (B3), so there is no one to send it to. The caller sends no notice to an
 * anonymised account anyway; this is the second layer.
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

export async function noticeLinks(
  c: Client,
  request: Request,
  input: { readonly actionId: string; readonly userId: string; readonly bars: boolean },
): Promise<NoticeLinks> {
  const origin = verificationLinkOrigin(request);
  const ttlMs = APPEAL_WINDOW_DAYS * DAY_MS;
  const out: NoticeLinks = {};
  const appeal = await mintActionToken(c, { actionId: input.actionId, userId: input.userId, purpose: "appeal", ttlMs });
  if (appeal !== null) out.appealUrl = `${origin}/appeal?token=${encodeURIComponent(appeal)}`;
  if (input.bars) {
    const del = await mintActionToken(c, { actionId: input.actionId, userId: input.userId, purpose: "delete_request", ttlMs });
    if (del !== null) out.deleteRequestUrl = `${origin}/account/delete-request?token=${encodeURIComponent(del)}`;
  }
  return out;
}
